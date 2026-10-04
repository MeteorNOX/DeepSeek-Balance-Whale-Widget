import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {verifyReleaseMetadata} from './release-metadata.mjs';
const version=verifyReleaseMetadata();
for(const name of ['../vendor/smol-toml/dist/index.js','../desktop/main.cjs','../desktop/ui/widget.html','../desktop/ui/gesture.js','../desktop/ui/audio-engine.js','../desktop/ui/insights.js','../desktop/ui/workshop.js','../assets/DSniang1.png']) {
  if(!fs.existsSync(fileURLToPath(new URL(name,import.meta.url))))throw new Error('Package dependency missing: '+name);
}
if(!fs.existsSync(fileURLToPath(new URL('../desktop/ui/account-view.js',import.meta.url))))throw new Error('Account view module is missing');
if(!fs.existsSync(fileURLToPath(new URL('../desktop/ui/shape.js',import.meta.url))))throw new Error('Window region module is missing');
if(!fs.existsSync(fileURLToPath(new URL('../desktop/ui/dashboard.js',import.meta.url))))throw new Error('Dashboard module is missing');
if(!fs.existsSync(fileURLToPath(new URL('../desktop/ui/account-notices.js',import.meta.url))))throw new Error('Account notification UI is missing');
if(!fs.existsSync(fileURLToPath(new URL('../runtime/account-notices.mjs',import.meta.url))))throw new Error('Account notification ledger is missing');
await import('../runtime/dispatcher.mjs');
await import('../runtime/process.mjs');
process.stdout.write('Package v' + version + ' metadata and dependency graph are complete.\n');
