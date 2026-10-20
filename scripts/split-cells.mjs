#!/usr/bin/env node
/**
 * facspot-data / scripts/split-cells.mjs
 *
 * Turns one country's `osmium export -f geojsonseq` stream into the
 * static facspot-data cell dataset. No npm dependencies.
 *
 *   node scripts/split-cells.mjs \
 *     --country BE \
 *     --input work/pois.geojsonseq \
 *     --out dist/v1/BE \
 *     --timestamp 2026-10-18T20:25:06Z \
 *     --source https://download.geofabrik.de/europe/belgium-latest.osm.pbf
 *
 * Writes:
 *   <out>/cells/<latIdx>_<lngIdx>.json      one file per occupied grid cell
 *   <out>/idx/<latBlock>_<lngBlock>.json    one index per occupied 1° block
 *   <out>/manifest.json                     country manifest
 *
 * Cell schema v1 (compact, one file per cell):
 *   {
 *     "v": 1,
 *     "cell": "1408_1843",              // latIdx_lngIdx at the configured grid
 *     "ts": "20261018T202506Z",         // OSM replication timestamp, compact
 *     "s": ["", "Central Station", …],   // per-cell string table; index 0 = absent
 *     "p": [[id, latE5, lngE5, cat, flags, name, hours, operator, image], …]
 *   }
 *
 *   id       OSM node id (number)
 *   latE5    latitude  * 1e5, rounded  (~1.1 m)
 *   lngE5    longitude * 1e5, rounded
 *   cat      index into config.categories[] (fixed order, append-only)
 *   flags    bitfield, see FLAG_FIELDS below
 *   name     string index (0 = no name)
 *   hours    string index (0 = no opening_hours)
 *   operator string index (0 = no operator/brand)
 *   image    string index (0 = no image); bit 14 of flags is set when the
 *            value is a Wikimedia Commons filename that must be wrapped in
 *            https://commons.wikimedia.org/wiki/Special:FilePath/<name>
 *
 * Skipped by design: waste baskets, EV chargers, and every non-node
 * element (the workflow filters with `n/` prefixes and this script
 * refuses ways/relations rather than guessing a representative point).
 */

import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SCHEMA_VERSION = 1
export const IMAGE_FROM_COMMONS = 1 << 14

// Enum -> 2-bit code. Values mirror src/lib/poi.ts in the app so the
// static dataset and the live Worker path agree on every detail row.
// Absent / unrecognised values stay 0 ("unknown").
export const FLAG_FIELDS = [
  { tag: 'wheelchair', shift: 0, lower: false, values: { yes: 1, no: 2 }, names: ['unknown', 'yes', 'no'] },
  // fee: 1 = free (fee=no), 2 = paid (fee=yes)
  { tag: 'fee', shift: 2, lower: false, values: { no: 1, yes: 2 }, names: ['unknown', 'free', 'paid'] },
  { tag: 'access', shift: 4, lower: false, values: { yes: 1, no: 2 }, names: ['unknown', 'yes', 'no'] },
  // changing_table: 1 = yes (also `designated`), 2 = limited, 3 = no
  { tag: 'changing_table', shift: 6, lower: true, values: { yes: 1, designated: 1, limited: 2, no: 3 }, names: ['unknown', 'yes', 'limited', 'no'] },
  { tag: 'bottle', shift: 8, lower: true, values: { yes: 1, no: 2 }, names: ['unknown', 'yes', 'no'] },
  { tag: 'indoor', shift: 10, lower: false, values: { yes: 1, no: 2 }, names: ['unknown', 'yes', 'no'] },
  { tag: 'stateofrepair', shift: 12, lower: false, values: { ok: 1, broken: 2 }, names: ['unknown', 'ok', 'broken'] },
]

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

function parseArgs(argv) {
  const args = { config: 'config/countries.json' }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw.startsWith('--')) throw new Error(`unexpected argument: ${raw}`)
    const key = raw.slice(2)
    if (key === 'allow-empty') {
      args.allowEmpty = true
      continue
    }
    const value = argv[++i]
    if (value === undefined) throw new Error(`--${key} requires a value`)
    args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
  }
  return args
}

function compactTs(iso) {
  return iso.replace(/[-:]/g, '')
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

function stripWikimediaPrefix(raw) {
  return raw
    .replace(/^https?:\/\/commons\.wikimedia\.org\/wiki\/File:/i, '')
    .replace(/^File:/i, '')
    .trim()
}

function looksLikeImageFilename(name) {
  return /\.(jpe?g|png|webp|svg|gif|avif)$/i.test(name)
}

// Reproduces parsePoiImage() from the app at build time so a cell only
// carries a single string plus one bit, instead of two raw tags.
function resolveImage(tags) {
  const direct = firstNonEmpty(tags.image, tags['image:0'])
  if (direct) {
    if (/^https?:\/\//i.test(direct)) return { value: direct, commons: false }
    const cleaned = stripWikimediaPrefix(direct)
    if (looksLikeImageFilename(cleaned)) return { value: cleaned, commons: true }
  }
  const commons = firstNonEmpty(tags.wikimedia_commons)
  if (commons) {
    const cleaned = stripWikimediaPrefix(commons)
    if (cleaned) return { value: cleaned, commons: true }
  }
  return null
}

function encodeFlags(tags) {
  let flags = 0
  for (const field of FLAG_FIELDS) {
    const raw = tags[field.tag]
    if (typeof raw !== 'string') continue
    const key = field.lower ? raw.trim().toLowerCase() : raw
    const code = field.values[key]
    if (code) flags |= code << field.shift
  }
  return flags
}

function latIndex(lat, grid) {
  return Math.floor((lat + 90) / grid + 1e-9)
}

function lngIndex(lng, grid) {
  return Math.floor((lng + 180) / grid + 1e-9)
}

function osmNodeId(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const match = raw.match(/(\d+)\s*$/)
  return match ? Number(match[1]) : null
}

function categoryFor(tags, categories) {
  for (let i = 0; i < categories.length; i++) {
    const rule = categories[i].filter
    const eq = rule.indexOf('=')
    const key = (eq === -1 ? rule : rule.slice(0, eq)).replace(/^[nwr]\//, '')
    const value = eq === -1 ? null : rule.slice(eq + 1)
    const actual = tags[key]
    if (typeof actual !== 'string') continue
    if (value === null || value === '*' || actual === value) return i
  }
  return -1
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const required of ['country', 'input', 'out', 'timestamp']) {
    if (!args[required]) throw new Error(`--${required} is required`)
  }
  if (!ISO_TS.test(args.timestamp)) {
    throw new Error(`--timestamp must look like 2026-10-18T20:25:06Z, got "${args.timestamp}"`)
  }

  const config = JSON.parse(await readFile(args.config, 'utf8'))
  const grid = Number(args.grid ?? config.grid)
  if (!Number.isFinite(grid) || grid <= 0) throw new Error('grid must be a positive number')

  const categories = config.categories ?? []
  if (categories.length === 0) throw new Error('config.categories is empty')

  const code = String(args.country).toUpperCase()
  const country = (config.countries ?? []).find((c) => c.code === code)
  if (!country) throw new Error(`country ${code} is not in ${args.config}`)

  const ts = compactTs(args.timestamp)
  const cells = new Map()
  const seen = new Map() // cellId -> Set(node id), guards against duplicate features
  const stats = { lines: 0, kept: 0, duplicate: 0, notNode: 0, notPoint: 0, noCategory: 0, noId: 0 }

  const input = args.input === '-' ? process.stdin : createReadStream(args.input)
  const rl = createInterface({ input, crlfDelay: Infinity })

  for await (const line of rl) {
    // `osmium export -f geojsonseq` prefixes every record with an ASCII
    // Record Separator (0x1e) and terminates it with a newline.
    const record = line.replace(/^\u001e+/, '')
    if (!record.trim()) continue
    stats.lines++

    let feature
    try {
      feature = JSON.parse(record)
    } catch {
      throw new Error(`line ${stats.lines}: not valid JSON (is this geojsonseq?)`)
    }
    if (feature?.type !== 'Feature') {
      throw new Error(`line ${stats.lines}: expected a GeoJSON Feature, got "${feature?.type}"`)
    }

    const tags = feature.properties ?? {}
    // `osmium export -u type_id` puts the OSM id in the GeoJSON `id`
    // member as "n123" / "w123" / "r123"; older variants expose it as
    // properties['@id']. Accept both, and reject non-node ids early.
    const rawId = feature.id ?? tags['@id']
    if (typeof rawId === 'string' && /^[wr]/.test(rawId)) {
      stats.notNode++
      continue
    }
    const type = tags['@type']
    if (type && type !== 'node') {
      stats.notNode++
      continue
    }
    if (feature.geometry?.type !== 'Point') {
      stats.notPoint++
      continue
    }

    const id = osmNodeId(rawId)
    if (id === null) {
      stats.noId++
      continue
    }

    const cat = categoryFor(tags, categories)
    if (cat === -1) {
      stats.noCategory++
      continue
    }

    const [lng, lat] = feature.geometry.coordinates
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      stats.notPoint++
      continue
    }

    const latIdx = latIndex(lat, grid)
    const lngIdx = lngIndex(lng, grid)
    const cellId = `${latIdx}_${lngIdx}`

    let cell = cells.get(cellId)
    if (!cell) {
      cell = { latIdx, lngIdx, strings: [''], stringIndex: new Map(), records: [] }
      cells.set(cellId, cell)
      seen.set(cellId, new Set())
    }
    const ids = seen.get(cellId)
    if (ids.has(id)) {
      stats.duplicate++
      continue
    }
    ids.add(id)

    const intern = (value) => {
      if (!value) return 0
      let idx = cell.stringIndex.get(value)
      if (idx === undefined) {
        idx = cell.strings.length
        cell.strings.push(value)
        cell.stringIndex.set(value, idx)
      }
      return idx
    }

    const image = resolveImage(tags)
    let flags = encodeFlags(tags)
    if (image?.commons) flags |= IMAGE_FROM_COMMONS

    cell.records.push([
      id,
      Math.round(lat * 1e5),
      Math.round(lng * 1e5),
      cat,
      flags,
      intern(firstNonEmpty(tags.name)),
      intern(firstNonEmpty(tags.opening_hours)),
      intern(firstNonEmpty(tags.operator, tags.brand)),
      intern(image ? image.value : ''),
    ])
    stats.kept++
  }

  const counts = new Array(categories.length).fill(0)
  for (const cell of cells.values()) {
    for (const record of cell.records) counts[record[3]]++
  }

  const cellsDir = path.join(args.out, 'cells')
  const idxDir = path.join(args.out, 'idx')
  await mkdir(cellsDir, { recursive: true })
  await mkdir(idxDir, { recursive: true })

  const blocks = new Map()
  let bytes = 0
  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity

  for (const cellId of [...cells.keys()].sort()) {
    const cell = cells.get(cellId)
    cell.records.sort((a, b) => a[3] - b[3] || a[0] - b[0])

    const payload = JSON.stringify({
      v: SCHEMA_VERSION,
      cell: cellId,
      ts,
      s: cell.strings,
      p: cell.records,
    })
    await writeFile(path.join(cellsDir, `${cellId}.json`), payload)
    bytes += Buffer.byteLength(payload)

    const block = `${Math.floor(cell.latIdx * grid + 1e-9)}_${Math.floor(cell.lngIdx * grid + 1e-9)}`
    if (!blocks.has(block)) blocks.set(block, {})
    const perCategory = new Array(categories.length).fill(0)
    for (const record of cell.records) perCategory[record[3]]++
    blocks.get(block)[cellId] = { n: cell.records.length, c: perCategory }

    minLat = Math.min(minLat, cell.latIdx)
    maxLat = Math.max(maxLat, cell.latIdx)
    minLng = Math.min(minLng, cell.lngIdx)
    maxLng = Math.max(maxLng, cell.lngIdx)
  }

  for (const block of [...blocks.keys()].sort()) {
    const [latBlock, lngBlock] = block.split('_')
    await writeFile(
      path.join(idxDir, `${block}.json`),
      JSON.stringify({ v: SCHEMA_VERSION, block, ts, cells: blocks.get(block) }),
    )
  }

  const total = stats.kept
  const manifest = {
    v: SCHEMA_VERSION,
    schema: SCHEMA_VERSION,
    country: code,
    name: country.name,
    grid,
    datasetTimestamp: args.timestamp,
    version: ts,
    generatedAt: new Date().toISOString(),
    source: args.source ?? `https://download.geofabrik.de/${country.geofabrik}-latest.osm.pbf`,
    license: 'ODbL-1.0',
    licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    attribution: '© OpenStreetMap contributors',
    attributionUrl: 'https://www.openstreetmap.org/copyright',
    categories: categories.map((c) => c.key),
    counts: Object.fromEntries(categories.map((c, i) => [c.key, counts[i]])),
    total,
    cells: cells.size,
    blocks: blocks.size,
    bytes,
    cellBBox:
      cells.size === 0
        ? null
        : [
            Number((minLng * grid - 180).toFixed(6)),
            Number((minLat * grid - 90).toFixed(6)),
            Number(((maxLng + 1) * grid - 180).toFixed(6)),
            Number(((maxLat + 1) * grid - 90).toFixed(6)),
          ],
  }
  await writeFile(path.join(args.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  process.stdout.write(
    JSON.stringify({ ...manifest, skipped: stats }, null, 2) + '\n',
  )

  if (total === 0 && !args.allowEmpty) {
    throw new Error(`no POIs produced for ${code} — refusing to publish an empty country`)
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`split-cells: ${error.message}\n`)
    process.exit(1)
  })
}
