import readline from 'node:readline';
import path from 'node:path';
import { ensureService, serviceRequest, launchDesktop } from './process.mjs';
import { DATA_HOME, VERSION, readJson } from './paths.mjs';

const toolSpecs = [
  { name: 'whale_balance', description: '查询当前 Codex API 服务商的余额、余额口径、币种及今日已观测用量。金额来源于当前 API；不会返回密钥，也不会将 ChatGPT 订阅配额当作 API 余额。', inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: '立即从 API 刷新' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'whale_usage', description: '读取小鲸鱼今日、近七天和历史用量记录。每日合计只覆盖挂件已观测时段，逐模型金额为配置价格估算。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'whale_status', description: '读取当前服务商、挂件状态和 Codex 会话用量监听状态，不返回 API 密钥。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'whale_open', description: '显示跟随 Codex 窗口的 API 余额小鲸鱼。使用本地透明挂件，无网页地址；角色、音效、气泡编辑和资源管理均在挂件中操作。', inputSchema: { type: 'object', properties: { desktop: { type: 'boolean', description: '打开桌面透明悬浮挂件' } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
];

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
async function dispatch(message) {
  const { id, method, params = {} } = message;
  if (id === undefined) return;
  try {
    let result;
    if (method === 'initialize') result = { protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'api-balance-whale', version: VERSION } };
    else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: toolSpecs };
    else if (method === 'resources/list' || method === 'resources/templates/list') result = method === 'resources/list' ? { resources: [] } : { resourceTemplates: [] };
    else if (method === 'tools/call') {
      const args = params.arguments || {};
      let output;
      if (params.name === 'whale_balance') output = await serviceRequest('/dsh-whale/balance.json' + (args.refresh ? '?refresh=1' : ''));
      else if (params.name === 'whale_usage') output = await serviceRequest('/dsh-whale/usage-records.json');
      else if (params.name === 'whale_status') output = await serviceRequest('/api/status');
      else if (params.name === 'whale_open') {
        if (args.desktop) output = await launchDesktop();
        else output = await launchDesktop();
      } else throw new Error('未知工具');
      result = { content: [{ type: 'text', text: JSON.stringify(output) }], isError: output.ok === false };
    } else { send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return; }
    send({ jsonrpc: '2.0', id, result });
  } catch { send({ jsonrpc: '2.0', id, error: { code: -32603, message: '挂件操作失败，请确认 Codex 桌面应用和自动跟随组件已运行' } }); }
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (line.length > 1024 * 1024) return;
  try { const message = JSON.parse(line); if (message.jsonrpc === '2.0') dispatch(message); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
});
input.on('close', () => process.exit(0));
