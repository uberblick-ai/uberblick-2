// Independent verification of R1-F1's synthetic sensitivity, not a realistic producer history.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import * as Y from '../../../packages/mcp-server/node_modules/yjs/dist/yjs.mjs';
import { generate, variants, writeInitial, readData } from './representations.mjs';

const output = [];
for (const fraction of [0.1, 1]) {
  for (const variant of variants) {
    const doc = new Y.Doc(); doc.clientID = 1398;
    const data = generate(1500); writeInitial(doc, variant, data);
    const milestones = [];
    for (let day = 0; day <= 365; day++) {
      if (day > 0) {
        doc.transact(() => {
          for (const [name, collection] of Object.entries(data.collections)) {
            for (let i = 0; i < collection.records.length; i++) {
              if (fraction === 1 || i % 10 === day % 10) {
                const row = collection.records[i];
                collection.records[i] = { ...row, value: row.value + 1 };
                if (variant === 'keyed-records') doc.getMap('spikeData').set('record:' + row.id, collection.records[i]);
              }
            }
            if (variant === 'collection-envelopes') doc.getMap('spikeData').set('collection:' + name, structuredClone(collection));
          }
          if (variant === 'document-envelope') doc.getMap('spikeData').set('envelope', structuredClone(data));
        });
      }
      if ([0,30,365].includes(day)) {
        const state = Y.encodeStateAsUpdate(doc);
        const fresh = new Y.Doc(); fresh.clientID = 1398; writeInitial(fresh, variant, data);
        const samples = [];
        for (let i = 0; i < 8; i++) {
          const cold = new Y.Doc();
          const started = performance.now(); Y.applyUpdate(cold, state);
          if (i > 0) samples.push(performance.now() - started);
          assert.deepEqual(readData(cold, variant), data); cold.destroy();
        }
        milestones.push({day,stateBytes:state.byteLength,freshEquivalentBytes:Y.encodeStateAsUpdate(fresh).byteLength,coldApplySamplesMs:samples});
        fresh.destroy();
      }
    }
    assert.deepEqual(readData(doc, variant), data); doc.destroy();
    output.push({fraction,variant,milestones});
    console.log(JSON.stringify({fraction,variant,milestones:milestones.map(({day,stateBytes})=>({day,stateBytes}))}));
  }
}
writeFileSync(new URL('./reviewer-verification.json', import.meta.url), JSON.stringify({method:'Independent verification, 1500 fixed records; daily value increment in all rows or rotating one of ten residue classes of collection ordinal; one transaction/day; exact logical data asserted; 1 warmup+7 fresh apply samples. Synthetic sensitivity only; not a producer history.',node:process.version, environment: {platform:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,memoryBytes:os.totalmem()},output},null,2)+'\n');
