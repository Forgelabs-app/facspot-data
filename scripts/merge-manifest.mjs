#!/usr/bin/env node
/**
 * facspot-data / scripts/merge-manifest.mjs
 *
 * Runs in the deploy job after every per-country artifact has been
 * unpacked into <dir>/v1/<CC>/. It validates each country manifest,
 * then writes the root manifest.json and a small index.html that
 * carries the OpenStreetMap / ODbL attribution.
 *
 *   node scripts/merge-manifest.mjs --dir dist --config config/countries.json
 *
 * Exits non-zero on any inconsistency, so a broken country directory can
 * never be published as part of a "successful" deployment.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { FLAG_FIELDS, IMAGE_FROM_COMMONS } from './split-cells.mjs'

function parseArgs(argv) {
  const args = { config: 'config/countries.json' }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw.startsWith('--')) throw new Error(`unexpected argument: ${raw}`)
    const key = raw.slice(2)
    const value = argv[++i]
    if (value === undefined) throw new Error(`--${key} requires a value`)
    args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
  }
  return args
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.dir) throw new Error('--dir is required')

  const dir = path.resolve(args.dir)
  const config = JSON.parse(await readFile(args.config, 'utf8'))
  const grid = Number(config.grid)
  const categories = (config.categories ?? []).map((c) => c.key)
  if (!Number.isFinite(grid) || grid <= 0) throw new Error('config.grid must be a positive number')
  if (categories.length === 0) throw new Error('config.categories is empty')

  const v1 = path.join(dir, 'v1')
  const codes = (await readdir(v1, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  if (codes.length === 0) throw new Error(`no country directories under ${v1}`)

  const countries = {}
  let total = 0
  let cellsTotal = 0
  let bytesTotal = 0
  let datasetTimestamp = ''
  let version = ''

  for (const code of codes) {
    const root = path.join(v1, code)
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'))

    if (manifest.v !== 1 || manifest.schema !== 1) {
      throw new Error(`${code}: unsupported manifest schema ${manifest.v}/${manifest.schema}`)
    }
    if (manifest.country !== code) throw new Error(`${code}: manifest.country is ${manifest.country}`)
    if (Number(manifest.grid) !== grid) throw new Error(`${code}: grid ${manifest.grid} != config ${grid}`)
    if (JSON.stringify(manifest.categories) !== JSON.stringify(categories)) {
      throw new Error(`${code}: categories differ from config order — reorder breaks the cat index`)
    }
    if (!(manifest.total > 0)) throw new Error(`${code}: manifest.total is ${manifest.total}`)

    const cellFiles = (await readdir(path.join(root, 'cells'))).filter((f) => f.endsWith('.json'))
    if (cellFiles.length !== manifest.cells) {
      throw new Error(`${code}: ${cellFiles.length} cell files != manifest.cells ${manifest.cells}`)
    }
    const idxFiles = (await readdir(path.join(root, 'idx'))).filter((f) => f.endsWith('.json'))
    if (idxFiles.length === 0) throw new Error(`${code}: no index files`)

    countries[code] = {
      name: manifest.name,
      path: `v1/${code}/`,
      datasetTimestamp: manifest.datasetTimestamp,
      version: manifest.version,
      grid: Number(manifest.grid),
      pois: manifest.total,
      cells: manifest.cells,
      blocks: manifest.blocks,
      bytes: manifest.bytes,
      counts: manifest.counts,
      cellBBox: manifest.cellBBox,
    }

    total += manifest.total
    cellsTotal += manifest.cells
    bytesTotal += manifest.bytes
    if (manifest.datasetTimestamp > datasetTimestamp) datasetTimestamp = manifest.datasetTimestamp
    if (manifest.version > version) version = manifest.version
  }

  const enabled = (config.countries ?? []).filter((c) => c.enabled).map((c) => c.code)
  const missing = enabled.filter((code) => !countries[code])

  const root = {
    v: 1,
    schema: 1,
    generatedAt: new Date().toISOString(),
    datasetTimestamp,
    version,
    grid,
    categories,
    license: 'ODbL-1.0',
    licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    attribution: '© OpenStreetMap contributors',
    attributionUrl: 'https://www.openstreetmap.org/copyright',
    total,
    cells: cellsTotal,
    bytes: bytesTotal,
    complete: missing.length === 0,
    missingEnabledCountries: missing,
    layout: {
      countryPath: 'v1/<CC>/',
      cell: 'cells/<latIdx>_<lngIdx>.json',
      index: 'idx/<latBlock>_<lngBlock>.json',
      latIdx: 'floor((lat + 90) / grid)',
      lngIdx: 'floor((lng + 180) / grid)',
      stringIndex0: 'absent',
      record: ['id', 'latE5', 'lngE5', 'cat', 'flags', 'name', 'hours', 'operator', 'image'],
      flags: Object.fromEntries(
        FLAG_FIELDS.map((field) => [field.tag, { shift: field.shift, values: field.names }]),
      ),
      imageFromCommons: {
        bit: Math.log2(IMAGE_FROM_COMMONS),
        meaning:
          'image value is a Wikimedia Commons filename; wrap with https://commons.wikimedia.org/wiki/Special:FilePath/',
      },
    },
    countries,
  }

  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(root, null, 2) + '\n')

  const rows = Object.entries(countries)
    .map(
      ([code, c]) =>
        `<tr><td><code>${escapeHtml(code)}</code></td><td>${escapeHtml(c.name)}</td><td>${c.pois}</td><td>${c.cells}</td><td>${humanBytes(c.bytes)}</td><td>${escapeHtml(c.datasetTimestamp)}</td></tr>`,
    )
    .join('\n')

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FacSpot static POI data</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 2rem 1rem; }
  main { max-width: 52rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  p.lead { margin: 0 0 2rem; opacity: .75; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid rgba(128,128,128,.3); }
  td:nth-child(n+3) { font-variant-numeric: tabular-nums; }
  footer { margin-top: 2rem; font-size: .85rem; opacity: .8; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
<h1>FacSpot static POI data</h1>
<p class="lead">Weekly OpenStreetMap extracts for toilets, drinking water, AEDs and ATMs, split into ${grid}° cells.</p>
<p>
  <strong>Data timestamp:</strong> <code>${escapeHtml(datasetTimestamp)}</code><br>
  <strong>Dataset version:</strong> <code>${escapeHtml(version)}</code><br>
  <strong>License:</strong> <a href="https://opendatacommons.org/licenses/odbl/1-0/">ODbL 1.0</a><br>
  <strong>Machine-readable manifest:</strong> <a href="./manifest.json">manifest.json</a>
</p>
<table>
<thead><tr><th>Code</th><th>Country</th><th>POIs</th><th>Cells</th><th>JSON</th><th>OSM timestamp</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<footer>
  Data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>,
  available under the <a href="https://opendatacommons.org/licenses/odbl/1-0/">Open Database License (ODbL) 1.0</a>.
  Extracts are derived from <a href="https://download.geofabrik.de/">Geofabrik</a> downloads.
</footer>
</main>
</body>
</html>
`
  await writeFile(path.join(dir, 'index.html'), html)

  process.stdout.write(
    JSON.stringify(
      { countries: Object.keys(countries).length, total, cells: cellsTotal, bytes: bytesTotal, datasetTimestamp, version, missing },
      null,
      2,
    ) + '\n',
  )

  if (missing.length > 0) {
    process.stderr.write(`merge-manifest: warning: enabled countries missing: ${missing.join(', ')}\n`)
  }
}

main().catch((error) => {
  process.stderr.write(`merge-manifest: ${error.message}\n`)
  process.exit(1)
})
