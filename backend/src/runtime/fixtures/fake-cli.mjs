import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const apiKeyAbsent = !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY;
if (process.env.TEST_MODE === 'capture-argv' && process.env.TEST_ARGV_FILE) writeFileSync(process.env.TEST_ARGV_FILE, JSON.stringify(args));
if (args.includes('--version')) { console.log(process.env.TEST_VERSION ?? 'fixture 1.0'); process.exit(0); }
if (args.includes('auth') && args.includes('status')) { console.log(JSON.stringify({ loggedIn: process.env.TEST_AUTH !== 'missing', email: 'must-not-be-logged@example.invalid' })); process.exit(0); }
if (args.includes('login') && args.includes('status')) { console.log(process.env.TEST_AUTH === 'missing' ? 'Not logged in' : 'Logged in using ChatGPT'); process.exit(0); }
if (process.env.TEST_MODE === 'hang') { setInterval(() => {}, 1000); }
if (process.env.TEST_MODE === 'spawn-child') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio:'ignore', windowsHide:true });
  writeFileSync(process.env.TEST_CHILD_PID_FILE, String(child.pid));
  setInterval(() => {}, 1000);
}
if (process.env.TEST_MODE === 'capture-prompt') {
  const stdin = readFileSync(0, 'utf8');
  const positionalPrompt = args.some(arg => arg.includes('"task":"Read fixture and summarize."'));
  const body=`stdinPrompt=${stdin.includes('"task":"Read fixture and summarize."')};positionalPrompt=${positionalPrompt};stdinSentinel=${args.includes('-')}`;
  if (args.includes('--json') && args.includes('exec')) {
    console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));
    console.log(JSON.stringify({type:'item.completed',item:{id:'message-1',type:'agent_message',text:JSON.stringify({body})}}));
    console.log(JSON.stringify({type:'turn.completed'}));
  } else console.log(JSON.stringify({type:'result',session_id:'fixture-session',result:JSON.stringify({body}),is_error:false}));
  process.exit(0);
}
if (process.env.TEST_MODE === 'codex-mcp-forward' && args.includes('--json') && args.includes('exec')) {
  writeFileSync(process.env.TEST_ARGV_FILE, JSON.stringify(args));
  const envOverride = args.find(value => value.startsWith('mcp_servers.shao.env_vars='));
  const names = envOverride ? JSON.parse(envOverride.slice(envOverride.indexOf('=') + 1)) : [];
  const mcpEnv = Object.fromEntries(names.filter(name => typeof process.env[name] === 'string').map(name => [name, process.env[name]]));
  const server = spawn(process.execPath, ['--experimental-strip-types', process.env.TEST_MCP_SHIM], { env:mcpEnv, stdio:['pipe','pipe','ignore'], windowsHide:true });
  let buffer=''; const pending=new Map();
  server.stdout.setEncoding('utf8');
  server.stdout.on('data',chunk=>{
    buffer+=chunk; const lines=buffer.split(/\r?\n/); buffer=lines.pop()??'';
    for(const line of lines){try{const message=JSON.parse(line);const resolve=pending.get(message.id);if(resolve){pending.delete(message.id);resolve(message);}}catch{}}
  });
  const rpc=(id,method,params={})=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('fixture MCP timeout'));},3000);
    pending.set(id,message=>{clearTimeout(timer);resolve(message);});
    server.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id,method,params})}\n`);
  });
  try {
    await rpc(1,'initialize',{protocolVersion:'2024-11-05'});
    server.stdin.write(`${JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})}\n`);
    const response=await rpc(2,'tools/call',{name:'get_context',arguments:{}});
    console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));
    console.log(JSON.stringify({type:'item.started',item:{id:'mcp-1',type:'mcp_tool_call',server:'shao',tool:'get_context',arguments:{}}}));
    console.log(JSON.stringify({type:'item.completed',item:{id:'mcp-1',type:'mcp_tool_call',status:response.result?.isError?'failed':'completed',result:response.result?.structuredContent??response.result}}));
    console.log(JSON.stringify({type:'item.completed',item:{id:'message-1',type:'agent_message',text:JSON.stringify({body:'fixture MCP complete'})}}));
    console.log(JSON.stringify({type:'turn.completed'}));
  } catch(error) {
    console.error('fixture MCP forwarding failed'); process.exitCode=1;
  } finally { server.kill(); }
  if (!process.exitCode) process.exit(0);
}
if (process.env.TEST_MODE === 'auth') { console.error('Authentication required'); process.exit(1); }
if (process.env.TEST_MODE === 'quota') { console.error('Usage limit reached'); process.exit(1); }
if (process.env.TEST_MODE === 'unknown') { console.error('Provider failed without classification'); process.exit(2); }
if (process.env.TEST_MODE === 'diagnostic') { console.error('Error: Unknown argument --mcp-config at C:\\Users\\Sample User\\mcp.json for test@example.invalid; bearer abcdefghijklmnopqrstuvwx1234567890'); process.exit(1); }
if (args.includes('--malformed') || process.env.TEST_MODE === 'malformed') { console.log('{malformed'); process.exit(0); }
if (process.env.TEST_MODE === 'tool-events' && args.includes('--json') && args.includes('exec')) {
  console.log(JSON.stringify({ type:'thread.started',thread_id:'fixture-thread' }));
  console.log(JSON.stringify({ type:'turn.started' }));
  console.log(JSON.stringify({ type:'item.started',item:{id:'call-1',type:'mcp_tool_call',server:'shao',tool:'send',arguments:{recipients:['peer'],body:'hello'}} }));
  console.log(JSON.stringify({ type:'item.completed',item:{id:'call-1',type:'mcp_tool_call',result:{status:'sent'}} }));
  console.log(JSON.stringify({ type:'item.completed',item:{id:'message-1',type:'agent_message',text:JSON.stringify({body:'fixture read-only; apiKeyAbsent='+apiKeyAbsent})} }));
  console.log(JSON.stringify({ type:'turn.completed',usage:{input_tokens:12,output_tokens:5} })); process.exit(0);
}
if (process.env.TEST_MODE === 'tool-events') {
  console.log(JSON.stringify({type:'system',session_id:'fixture-session'}));
  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'call-1',name:'shao__send',input:{recipients:['peer'],body:'hello'}}]}}));
  console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'call-1',content:{status:'sent'},is_error:false}]}}));
  console.log(JSON.stringify({type:'result',session_id:'fixture-session',result:JSON.stringify({body:'fixture read-only; apiKeyAbsent='+apiKeyAbsent}),usage:{input_tokens:10,output_tokens:4},is_error:false})); process.exit(0);
}
if (args.includes('--json') && args.includes('exec')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ body: `fixture read-only; apiKeyAbsent=${apiKeyAbsent}` }) } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 5 } })); process.exit(0);
}
console.log(JSON.stringify({ type: 'system', session_id: 'fixture-session' }));
console.log(JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'fixture read-only' } } }));
console.log(JSON.stringify({ type: 'result', session_id: 'fixture-session', result: JSON.stringify({ body: `fixture read-only; apiKeyAbsent=${apiKeyAbsent}` }), is_error: false }));
