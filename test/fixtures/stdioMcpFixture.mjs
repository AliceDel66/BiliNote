#!/usr/bin/env node
/**
 * 测试用 stdio MCP fixture（换行分隔 JSON-RPC 2.0，FastMCP/stdio 帧格式）。
 * 供 scripts/bridge.mjs mcp-proxy 的真实子进程测试使用：
 * - initialize：先打印一行非 JSON 杂讯（验证代理对脏 stdout 行的容忍），再正常应答；
 * - tools/list / tools/call：固定应答；
 * - die：以 code 3 退出（验证子进程崩溃 → JSON-RPC error）；
 * - hang：永不应答（验证代理超时路径）；
 * - 通知（无 id）与无法解析的行：忽略。
 */
import readline from 'node:readline';

let greeted = false;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg.method !== 'string') return;
  if (msg.id === undefined || msg.id === null) return; // 通知（如 notifications/initialized）
  const { id, method } = msg;
  if (method === 'die') process.exit(3);
  if (method === 'hang') return; // 永不回复 → 触发代理超时
  if (method === 'initialize') {
    if (!greeted) {
      greeted = true;
      process.stdout.write('fixture-stdout-junk-line\n'); // 非 JSON 行应被代理忽略
    }
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'fixture-mcp', version: '0.0.1' },
        capabilities: {},
      },
    });
  }
  if (method === 'tools/list') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          { name: 'create_document_with_toc', description: '新建语雀文档' },
          { name: 'get_document', description: '读取语雀文档' },
        ],
      },
    });
  }
  if (method === 'tools/call') {
    return send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: '{"documentId":"doc-1"}' }] },
    });
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});
