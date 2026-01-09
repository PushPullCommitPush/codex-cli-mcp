#!/usr/bin/env node
/**
 * Codex MCP Server - stdio transport
 * Wraps codex CLI for local execution via MCP protocol
 * Mac-side version
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

// Ensure workdir exists
fs.mkdirSync(WORKDIR, { recursive: true });

const TOOLS = {
  codex_run: {
    description: 'Run a task with Codex CLI. Returns output when complete.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task description for Codex' },
        model: { type: 'string', description: 'Model to use (optional)' },
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
        prompt: { type: 'string', description: 'Follow-up message' }
      },
      required: ['prompt']
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

function runCodex(prompt, model, timeout) {
  return new Promise((resolve) => {
    const cmdArgs = [
      'exec',
      '--full-auto',
      '--skip-git-repo-check'
    ];
    
    if (model) {
      cmdArgs.push('-m', model);
    }
    
    cmdArgs.push(prompt);
    
    const proc = spawn(CODEX_PATH, cmdArgs, {
      cwd: WORKDIR,
      timeout: (timeout || 300) * 1000,
      env: { ...process.env, CODEX_QUIET: '1' }
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    
    proc.on('close', (code) => {
      // Trim to last 50KB if too long
      const maxLen = 50000;
      if (stdout.length > maxLen) {
        stdout = '...[truncated]...\n' + stdout.slice(-maxLen);
      }
      resolve({ code, stdout, stderr: stderr.slice(-5000) });
    });
    
    proc.on('error', (err) => {
      resolve({ code: 1, stdout: '', stderr: err.message });
    });
  });
}

function resumeCodex(prompt) {
  return new Promise((resolve) => {
    const proc = spawn(CODEX_PATH, ['exec', 'resume', '--last', prompt], {
      cwd: WORKDIR,
      timeout: 300000,
      env: { ...process.env, CODEX_QUIET: '1' }
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    
    proc.on('close', (code) => {
      const maxLen = 50000;
      if (stdout.length > maxLen) {
        stdout = '...[truncated]...\n' + stdout.slice(-maxLen);
      }
      resolve({ code, stdout, stderr: stderr.slice(-5000) });
    });
    
    proc.on('error', (err) => {
      resolve({ code: 1, stdout: '', stderr: err.message });
    });
  });
}

async function handleToolCall(name, args) {
  switch (name) {
    case 'codex_run': {
      const result = await runCodex(args.prompt, args.model, args.timeout);
      return { content: [{ type: 'text', text: result.stdout || result.stderr || '(no output)' }] };
    }
    
    case 'codex_resume': {
      const result = await resumeCodex(args.prompt);
      return { content: [{ type: 'text', text: result.stdout || result.stderr || '(no output)' }] };
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
          serverInfo: { name: 'codex-mcp', version: '1.0.0' }
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

process.stderr.write('codex-mcp started (workdir: ' + WORKDIR + ')\n');
