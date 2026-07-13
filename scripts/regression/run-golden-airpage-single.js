#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const goldenRoot = path.resolve(root, '..', 'workspaces', 'airpage-docx-export-poc');
const { AirPageDocxExporter } = require(path.join(goldenRoot, 'src', 'airpage_docx_exporter'));

function parseArgs(argv) {
  const options = { sample: '', outputDir: '', result: '' };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sample') options.sample = argv[++index] || '';
    else if (arg === '--output-dir') options.outputDir = argv[++index] || '';
    else if (arg === '--result') options.result = argv[++index] || '';
  }
  if (!options.sample || !options.outputDir || !options.result) {
    throw new Error('--sample, --output-dir and --result are required');
  }
  return options;
}

function outputPathFor(sample, outputDir) {
  const relative = sample.local_path || sample.path || sample.output_name || sample.name || `file-${sample.file_id}.docx`;
  const parsed = path.parse(relative);
  const dirParts = parsed.dir.split(/[\\/]+/).filter(Boolean);
  const base = (sample.output_name || parsed.base || `file-${sample.file_id}.docx`).replace(/\.[^.]+$/, '.docx');
  return path.resolve(outputDir, ...dirParts, base);
}

async function main() {
  const options = parseArgs(process.argv);
  const sample = JSON.parse(fs.readFileSync(options.sample, 'utf8'));
  const outputPath = outputPathFor(sample, options.outputDir);
  const exporter = new AirPageDocxExporter({ timeoutMs: 120000, pollMs: 1500 });
  const started = Date.now();
  const result = await exporter.exportFile(sample, { outputPath });
  const payload = {
    schemaVersion: 1,
    implementation: 'golden',
    goldenModule: path.join(goldenRoot, 'src', 'airpage_docx_exporter.js'),
    samplePath: path.resolve(options.sample),
    durationMs: Date.now() - started,
    result,
  };
  fs.mkdirSync(path.dirname(options.result), { recursive: true });
  fs.writeFileSync(options.result, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: Boolean(result.ok),
    implementation: 'golden',
    result: path.resolve(options.result),
    outputPath: result.output_path || outputPath,
    errorCode: result.error_code || '',
  }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error_name: error.name, error_message: error.message }, null, 2));
  process.exitCode = 1;
});
