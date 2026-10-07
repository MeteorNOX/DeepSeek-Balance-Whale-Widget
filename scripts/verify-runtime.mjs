import { bridgeRequest } from '../runtime/bridge.mjs';
import path from 'node:path';
import { VERSION, ROOT, DATA_HOME, readJson } from '../runtime/paths.mjs';
const expectedBuild = readJson(path.join(ROOT, '.codex-plugin/plugin.json'), {}).version;
let verified=false;
// Cold native compilation and Electron startup can exceed eight seconds on
// a busy Windows host; keep a bounded readiness wait.
for(let attempt=0;attempt<60;attempt++) {
  try { const s=await bridgeRequest('/api/status',{timeoutMs:1500}); if(s.ok && s.version===VERSION && s.buildVersion===expectedBuild && s.rendererReady){verified=true;break;} } catch {}
  await new Promise(resolve=>setTimeout(resolve,500));
}
if(!verified && process.argv.includes('--allow-idle')) {
  const follow=readJson(path.join(DATA_HOME,'follow-state.json'),{}),config=readJson(path.join(DATA_HOME,'follow-config.json'),{});
  if(config.mode==='follow-codex' && follow.state?.hostAlive===false && Date.now()-Date.parse(follow.at)<10000) {verified=true;process.stdout.write('No Codex window: fresh supervisor is waiting for the host.\n');}
}
if(!verified){process.stderr.write('Desktop runtime is not ready or its build does not match. If the widget was paused, explicitly open it before retrying. Installation is not yet verified; keep the rollback receipt.\n');process.exitCode=1;}
else process.stdout.write('Desktop runtime is reachable and version matches.\n');
