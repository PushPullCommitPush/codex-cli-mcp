#!/usr/bin/env node
/**
 * Codex MCP Server - stdio transport
 * Wraps codex CLI for local execution via MCP protocol
 * Mac-side version with hybrid profile support (OpenWebUI-backed)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Parse --workdir arg
const args = process.argv.slice(2);
const workdirIdx = args.indexOf('--workdir');
const WORKDIR = workdirIdx !== -1 && args[workdirIdx + 1] 
  ? args[workdirIdx + 1] 
  : path.join(process.env.HOME, 'codex-work');

// Codex binary path (homebrew default)
const CODEX_PATH = process.env.CODEX_PATH || '/opt/homebrew/bin/codex';

// OpenWebUI database for dynamic model discovery
const OPENWEBUI_DB = process.env.OPENWEBUI_DB || path.join(process.env.HOME, 'Desktop/MAIN WORKSPACE/openwebui-data/webui.db');

// CODEX_HOME layout
const MAIN_CODEX_HOME = __dirname; // shared home for fast/heavy/reasoning/coder profiles
const SECURITY_CODEX_HOME = path.join(__dirname, 'profiles', 'security'); // isolated home for security profile
const CONFIG_PATH = path.join(MAIN_CODEX_HOME, 'config.toml');
const SECURITY_CONFIG_PATH = path.join(SECURITY_CODEX_HOME, 'config.toml');

// Workspace root (trusted project path)
const WORKSPACE_ROOT = path.join(process.env.HOME || '', 'Desktop/MAIN WORKSPACE');

// Fallback models if OpenWebUI DB unavailable
const FALLBACK_MODELS = [
  { id: 'default', name: 'Codex Max (default)', base_model_id: 'codex-max' },
  { id: 'oss20b', name: 'OSS 20B (fast operator)', base_model_id: 'gpt-oss:20b-cloud' },
  { id: 'oss120b', name: 'OSS 120B (heavy operator)', base_model_id: 'gpt-oss:120b-cloud' },
  { id: 'deepseek', name: 'Deepseek v3.1 (reasoning)', base_model_id: 'deepseek-v3.1:671b-cloud' },
  { id: 'qwen-coder', name: 'Qwen3 Coder 480B', base_model_id: 'qwen3-coder:480b-cloud' },
  { id: 'security', name: 'Kimi K2 Thinking', base_model_id: 'kimi-k2-thinking:cloud' }
];

// Legacy aliases -> current profile ids
const PROFILE_ALIASES = {
  default: 'default',
  fast: 'oss20b',
  heavy: 'oss120b',
  reasoning: 'deepseek',
  coder: 'qwen-coder',
  kimi: 'security',
  security: 'security'
};

// Ensure workdir exists
fs.mkdirSync(WORKDIR, { recursive: true });
fs.mkdirSync(SECURITY_CODEX_HOME, { recursive: true });

const TOOLS = {
  codex_run: {
    description: 'Run a task with Codex CLI. Returns output when complete.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task description for Codex' },
        profile: { 
          type: 'string', 
          description: 'Profile to use (dynamically loaded from OpenWebUI). Legacy aliases: fast, heavy, reasoning, coder, security/kimi. Omit for default.'
        },
        model: { type: 'string', description: 'Model override (optional, ignores profile)' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 300)' }
      },
      required: ['prompt']
    }
  },
  codex_resume: {
    description: 'Resume the last Codex session with additional input.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Follow-up message' },
        profile: { 
          type: 'string', 
          description: 'Profile that was used (must match original session). Legacy aliases supported.'
        }
      },
      required: ['prompt']
    }
  },
  codex_profiles: {
    description: 'List available Codex profiles and their models',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  fs_read: {
    description: 'Read a file from the work directory',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within workdir' }
      },
      required: ['path']
    }
  },
  fs_write: {
    description: 'Write a file to the work directory',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within workdir' },
        content: { type: 'string', description: 'File content' }
      },
      required: ['path', 'content']
    }
  },
  fs_list: {
    description: 'List files in the work directory',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path (default: .)' }
      }
    }
  }
};

function trimOutput(str, limit = 50000) {
  if (!str) return '';
  return str.length > limit ? '...[truncated]...\n' + str.slice(-limit) : str;
}

function normalizeProfileId(id) {
  if (!id) return null;
  if (PROFILE_ALIASES[id]) return PROFILE_ALIASES[id];
  return id;
}

function parseModelRows(raw) {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name, base_model_id] = line.split('|');
      return { id, name, base_model_id };
    });
}

function readModelsFromDb() {
  return new Promise((resolve) => {
    const rows = [];
    const proc = spawn('sqlite3', [OPENWEBUI_DB, 'SELECT id, name, base_model_id FROM model;']);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 3000);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim().length) {
        resolve({ models: parseModelRows(stdout), source: 'openwebui', stderr: trimOutput(stderr, 2000) });
      } else {
        resolve({ models: [], source: 'error', stderr: trimOutput(stderr || `sqlite exit code ${code}`, 2000) });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ models: [], source: 'error', stderr: err.message });
    });
  });
}

function buildProfileMap(modelRows) {
  const map = {};
  modelRows.forEach((row) => {
    const id = normalizeProfileId(row.id);
    if (!id) return;
    // Map security/kimi to isolated profile id
    if (row.id === 'kimi' || id === 'security') {
      map.security = { id: 'security', displayId: 'security', name: row.name || 'Security', baseModel: row.base_model_id };
      return;
    }
    map[id] = { id, displayId: id, name: row.name || id, baseModel: row.base_model_id };
  });

  // Ensure security alias exists even if not present in DB
  if (!map.security && modelRows.some((r) => r.base_model_id === 'kimi-k2-thinking:cloud')) {
    map.security = { id: 'security', displayId: 'security', name: 'Security', baseModel: 'kimi-k2-thinking:cloud' };
  }

  const nonSecurityIds = Object.keys(map).filter((k) => k !== 'security');
  const defaultProfile = map.default ? 'default' : (nonSecurityIds[0] || Object.keys(map)[0] || null);
  return { map, defaultProfile };
}

function writeIfChanged(targetPath, content) {
  try {
    const existing = fs.readFileSync(targetPath, 'utf-8');
    if (existing === content) return;
  } catch (_) {
    // ignore
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content);
}

function generateProfileBlock(id, name, model, opts = {}) {
  const approval = opts.approval_policy || 'on-failure';
  const sandbox = opts.sandbox_mode || 'workspace-write';
  const provider = opts.provider === undefined ? 'ollama' : opts.provider;
  return `
[profiles.${id}]
model = "${model}"
${provider ? `model_provider = "${provider}"` : ''}
approval_policy = "${approval}"
sandbox_mode = "${sandbox}"
model_reasoning_effort = "high"
model_reasoning_summary = "detailed"
model_verbosity = "low"
tool_output_token_limit = 30000

${provider ? `[profiles.${id}.model_providers.${provider}]
name = "${provider === 'ollama' ? 'Ollama' : provider}"
base_url = "http://localhost:11434/v1"
wire_api = "responses"
` : ''}

[profiles.${id}.features]
web_search_request = true
view_image_tool = true
shell_snapshot = true
parallel = true
unified_exec = true
skills = true

[profiles.${id}.shell_environment_policy]
inherit = "all"
ignore_default_excludes = false
exclude = ["*KEY*", "*SECRET*", "*TOKEN*", "*PASSWORD*", "*CREDENTIAL*"]

[profiles.${id}.history]
persistence = "save-all"
max_bytes = 10485760

[profiles.${id}.tui]
notifications = ["agent-turn-complete"]
animations = true

[profiles.${id}.projects."${WORKSPACE_ROOT}"]
trust_level = "trusted"
`.trim();
}

function renderMainConfig(profileMap, defaultProfile) {
  const entries = Object.values(profileMap).filter((p) => p.id !== 'security');
  const defaultLine = defaultProfile && entries.some((p) => p.id === defaultProfile)
    ? `default_profile = "${defaultProfile}"\n`
    : '';
  const header = `# Autogenerated by codex-mcp (do not edit manually)\n# Source: ${OPENWEBUI_DB}\n` + defaultLine;
  const blocks = entries.map((p) => generateProfileBlock(
    p.id,
    p.name,
    p.baseModel,
    {
      approval_policy: 'on-request',
      sandbox_mode: p.id === 'default' ? 'danger-full-access' : 'workspace-write',
      provider: p.id === 'default' ? null : 'ollama'
    }
  ));
  return [header, ...blocks].filter(Boolean).join('\n\n') + '\n';
}

function renderSecurityConfig(securityProfile) {
  if (!securityProfile) return '# Security profile not available\n';
  const header = '# Autogenerated by codex-mcp (security isolated)\n';
  const block = generateProfileBlock(securityProfile.id, securityProfile.name, securityProfile.baseModel, {
    approval_policy: 'untrusted',
    sandbox_mode: 'workspace-write'
  });
  return `${header}${block}\n`;
}

async function loadProfilesAndSyncConfigs() {
  const { models, source, stderr } = await readModelsFromDb();
  const modelRows = models.length ? [...models] : [...FALLBACK_MODELS];
  if (!modelRows.some((m) => m.id === 'default')) {
    modelRows.unshift({ id: 'default', name: 'Codex Max (default)', base_model_id: 'codex-max' });
  }
  const { map, defaultProfile } = buildProfileMap(modelRows);

  const mainProfiles = Object.values(map).filter((p) => p.id !== 'security');
  const mainDefault = mainProfiles[0]?.id || (map.security ? null : defaultProfile);

  // Write configs (main + security)
  const mainConfig = renderMainConfig(map, mainDefault);
  writeIfChanged(CONFIG_PATH, mainConfig);
  if (map.security) {
    const secConfig = renderSecurityConfig(map.security);
    writeIfChanged(SECURITY_CONFIG_PATH, secConfig);
  }

  return {
    profiles: map,
    defaultProfile: mainDefault || defaultProfile,
    source,
    stderr
  };
}

function buildEnvForProfile(profileId, isSecurity) {
  const env = { ...process.env };
  delete env.CODEX_HOME; // sanitize external override
  delete env.CODEX_CONFIG;
  env.CODEX_QUIET = '1';
  env.CODEX_HOME = isSecurity ? SECURITY_CODEX_HOME : MAIN_CODEX_HOME;
  return env;
}

function resolveProfile(profiles, requestedProfile, defaultProfile) {
  const normalized = normalizeProfileId(requestedProfile) || defaultProfile;
  if (!normalized || !profiles[normalized]) {
    return { id: null, info: null, isSecurity: false };
  }
  return { id: normalized, info: profiles[normalized], isSecurity: normalized === 'security' };
}

async function runCodex(prompt, profile, model, timeout) {
  const { profiles, defaultProfile } = await loadProfilesAndSyncConfigs();
  const { id: profileId, info, isSecurity } = resolveProfile(profiles, profile, defaultProfile);

  if (!profileId && profile) {
    return { code: 1, stdout: '', stderr: `Unknown profile "${profile}".` };
  }

  const cmdArgs = ['exec'];

  const sandbox = profileId === 'default' ? 'danger-full-access' : 'workspace-write';
  const approval = profileId === 'security' ? 'untrusted' : 'on-request';

  const globalArgs = [];
  if (profileId === 'security') {
    globalArgs.push('-a', approval, '--sandbox', sandbox, '--profile', 'security');
  } else {
    globalArgs.push('--dangerously-bypass-approvals-and-sandbox');
    if (profileId && profileId !== 'default') {
      globalArgs.push('--profile', profileId);
    }
  }
  cmdArgs.unshift(...globalArgs);

  cmdArgs.push('--skip-git-repo-check');

  // Model override takes precedence, otherwise rely on profile model in config
  if (model) {
    cmdArgs.push('-m', model);
  }

  cmdArgs.push(prompt);

  const env = buildEnvForProfile(profileId, isSecurity);

  return new Promise((resolve) => {
    const proc = spawn(CODEX_PATH, cmdArgs, {
      cwd: WORKDIR,
      timeout: (timeout || 300) * 1000,
      env
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    
    proc.on('close', (code) => {
      const profileInfo = profileId ? `[profile: ${profileId}] ` : '[profile: default] ';
      resolve({
        code,
        stdout: profileInfo + '\n' + trimOutput(stdout),
        stderr: trimOutput(stderr, 5000)
      });
    });
    
    proc.on('error', (err) => {
      resolve({ code: 1, stdout: '', stderr: err.message });
    });
  });
}

async function resumeCodex(prompt, profile) {
  const { profiles, defaultProfile } = await loadProfilesAndSyncConfigs();
  const { id: profileId, isSecurity } = resolveProfile(profiles, profile, defaultProfile);

  if (!profileId && profile) {
    return { code: 1, stdout: '', stderr: `Unknown profile "${profile}".` };
  }

  const env = buildEnvForProfile(profileId, isSecurity);
  
  return new Promise((resolve) => {
    const sandbox = profileId === 'default' ? 'danger-full-access' : 'workspace-write';
    const approval = profileId === 'security' ? 'untrusted' : 'on-request';

    const cmd = [];
    if (profileId === 'security') {
      cmd.push('-a', approval, '--sandbox', sandbox, '--profile', 'security');
    } else {
      cmd.push('--dangerously-bypass-approvals-and-sandbox');
      if (profileId && profileId !== 'default') {
        cmd.push('--profile', profileId);
      }
    }
    cmd.push('exec', 'resume', '--last', prompt);

    const proc = spawn(CODEX_PATH, cmd, {
      cwd: WORKDIR,
      timeout: 300000,
      env
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    
    proc.on('close', (code) => {
      resolve({
        code,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr, 5000)
      });
    });
    
    proc.on('error', (err) => {
      resolve({ code: 1, stdout: '', stderr: err.message });
    });
  });
}

async function handleToolCall(name, args) {
  switch (name) {
    case 'codex_run': {
      const result = await runCodex(args.prompt, args.profile, args.model, args.timeout);
      const combined = (result.stdout || '') + (result.stderr ? `\n\nstderr:\n${result.stderr}` : '');
      return { content: [{ type: 'text', text: combined.trim() || '(no output)' }] };
    }
    
    case 'codex_resume': {
      const result = await resumeCodex(args.prompt, args.profile);
      const combined = (result.stdout || '') + (result.stderr ? `\n\nstderr:\n${result.stderr}` : '');
      return { content: [{ type: 'text', text: combined.trim() || '(no output)' }] };
    }
    
    case 'codex_profiles': {
      const { profiles, defaultProfile, source, stderr } = await loadProfilesAndSyncConfigs();
      const list = Object.values(profiles).map((p) => {
        const alias = Object.entries(PROFILE_ALIASES).find(([k, v]) => v === p.id && k !== p.id);
        const aliasText = alias ? ` (alias: ${alias[0]})` : '';
        const isolation = p.id === 'security' ? ' [isolated CODEX_HOME]' : '';
        return `• ${p.id}: ${p.name} (${p.baseModel})${aliasText}${isolation}`;
      }).join('\n');

      const meta = `Source: ${source}${stderr ? ` (notes: ${stderr})` : ''}`;
      const def = defaultProfile ? `Default profile: ${defaultProfile}` : 'Default profile: (none)';
      return { content: [{ type: 'text', text: 'Available profiles:\n' + list + '\n' + def + '\n' + meta }] };
    }
    
    case 'fs_read': {
      try {
        const fullPath = path.resolve(WORKDIR, args.path);
        if (!fullPath.startsWith(WORKDIR)) throw new Error('Path outside workdir');
        const content = fs.readFileSync(fullPath, 'utf-8');
        return { content: [{ type: 'text', text: content.slice(0, 256000) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
      }
    }
    
    case 'fs_write': {
      try {
        const fullPath = path.resolve(WORKDIR, args.path);
        if (!fullPath.startsWith(WORKDIR)) throw new Error('Path outside workdir');
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, args.content);
        return { content: [{ type: 'text', text: 'Written: ' + args.path }] };
      } catch (e) {
        return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
      }
    }
    
    case 'fs_list': {
      try {
        const targetPath = path.resolve(WORKDIR, args.path || '.');
        if (!targetPath.startsWith(WORKDIR)) throw new Error('Path outside workdir');
        const entries = fs.readdirSync(targetPath, { withFileTypes: true });
        const list = entries.map(e => (e.isDirectory() ? '[D] ' : '[F] ') + e.name).join('\n');
        return { content: [{ type: 'text', text: list || '(empty)' }] };
      } catch (e) {
        return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
      }
    }
    
    default:
      return { content: [{ type: 'text', text: 'Unknown tool: ' + name }], isError: true };
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'codex-mcp', version: '2.0.0' }
        }
      });
      break;
      
    case 'notifications/initialized':
      // No response needed
      break;
      
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: Object.entries(TOOLS).map(([name, def]) => ({
            name,
            description: def.description,
            inputSchema: def.inputSchema
          }))
        }
      });
      break;
      
    case 'tools/call':
      try {
        const result = await handleToolCall(params.name, params.arguments || {});
        send({ jsonrpc: '2.0', id, result });
      } catch (e) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
      }
      break;
      
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }
}

// Main loop
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  try {
    const msg = JSON.parse(line);
    await handleMessage(msg);
  } catch (e) {
    // Ignore parse errors
  }
});

process.stderr.write('codex-mcp hybrid started (workdir: ' + WORKDIR + ', config: ' + CONFIG_PATH + ')\n');
