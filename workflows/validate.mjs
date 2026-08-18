#!/usr/bin/env node
/**
 * Structural validation for the exported n8n workflows.
 *
 * n8n will happily import a workflow whose connections point at nodes that no
 * longer exist, whose error branch goes nowhere, or whose Code node has a typo
 * in it. You find out at 2am, on the one execution that takes the error path.
 *
 * This catches the mechanical mistakes before a commit lands:
 *
 *   1. every connection resolves to a node that exists
 *   2. every $('Node Name') expression names a node that exists
 *   3. every node with an error output has that branch wired
 *   4. no orphaned nodes
 *   5. every Code node body parses as JavaScript
 *
 * Usage:  node workflows/validate.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const TRIGGER_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.manualTrigger',
]);

function validate(workflow) {
  const problems = [];
  const names = new Set(workflow.nodes.map((n) => n.name));

  if (names.size !== workflow.nodes.length) {
    problems.push('duplicate node names — n8n expression references would be ambiguous');
  }

  for (const [source, conn] of Object.entries(workflow.connections)) {
    if (!names.has(source)) problems.push(`connection source does not exist: ${source}`);
    for (const output of conn.main ?? []) {
      for (const target of output ?? []) {
        if (!names.has(target.node)) {
          problems.push(`connection target does not exist: ${target.node}`);
        }
      }
    }
  }

  // Expression references, e.g. $('Parse & Score Risk').first().json.foo
  for (const match of JSON.stringify(workflow).matchAll(/\$\(\\?'([^'\\]+)\\?'\)/g)) {
    if (!names.has(match[1])) {
      problems.push(`expression references a node that does not exist: ${match[1]}`);
    }
  }

  for (const node of workflow.nodes) {
    if (node.onError === 'continueErrorOutput') {
      const conn = workflow.connections[node.name];
      if (!conn || (conn.main?.length ?? 0) < 2 || !conn.main[1]?.length) {
        problems.push(`"${node.name}" has an error output with nothing wired to it`);
      }
    }

    if (node.type === 'n8n-nodes-base.code') {
      try {
        new Function(node.parameters.jsCode);
      } catch (error) {
        problems.push(`Code node "${node.name}" does not parse: ${error.message}`);
      }
    }
  }

  const reachable = new Set();
  for (const conn of Object.values(workflow.connections)) {
    for (const output of conn.main ?? []) {
      for (const target of output ?? []) reachable.add(target.node);
    }
  }
  for (const node of workflow.nodes) {
    if (!reachable.has(node.name) && !TRIGGER_TYPES.has(node.type)) {
      problems.push(`orphaned node (nothing connects to it): ${node.name}`);
    }
  }

  return problems;
}

let failed = 0;
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

if (files.length === 0) {
  console.error('no workflow JSON files found');
  process.exit(1);
}

for (const file of files) {
  let workflow;
  try {
    workflow = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  } catch (error) {
    console.log(`FAIL ${file}\n     - invalid JSON: ${error.message}`);
    failed += 1;
    continue;
  }

  const problems = validate(workflow);
  if (problems.length > 0) {
    failed += 1;
    console.log(`FAIL ${file}`);
    for (const problem of problems) console.log(`     - ${problem}`);
  } else {
    const codeNodes = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.code').length;
    console.log(
      `PASS ${file}  (${workflow.nodes.length} nodes, ${codeNodes} code node${codeNodes === 1 ? '' : 's'})`,
    );
  }
}

if (failed > 0) {
  console.log(`\n${failed} of ${files.length} workflow(s) failed validation`);
  process.exit(1);
}
console.log(`\nall ${files.length} workflows valid`);
