# facspot-data

Static OpenStreetMap extracts for **FacSpot** — toilets, drinking water, AEDs
and ATMs — split into small per-cell JSON files so the app can paint instantly
and work offline, with the live Overpass/Worker path kept only as a fallback.

Data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
available under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

**Dataset timestamp (the OSM replication date this data was cut from):** see
`datasetTimestamp` in [`manifest.json`](./manifest.json), or the table on the
site root. It comes from `osmosis_replication_timestamp` in the Geofabrik PBF
header (fallback: `<country>-updates/state.txt`, then HTTP `Last-Modified`), so
it is the exact extract time, never the workflow run time.

## What is in here

```
config/countries.json              country list + category filters (the only file to edit)
.github/workflows/build-data.yml   weekly pipeline: one job per country, one deploy job
scripts/split-cells.mjs            geojsonseq -> compact per-cell JSON (no dependencies)
scripts/merge-manifest.mjs         validates country output, writes root manifest + index.html
```

Generated data is **never committed**. The matrix downloads a Geofabrik extract,
filters it with `osmium`, and ships per-country artifacts to a single deploy job
that publishes to GitHub Pages.

## Layout of the published site

```
manifest.json                       root manifest: schema, dataset timestamp, per-country metadata
index.html                          human-readable index + attribution
v1/<CC>/manifest.json               country manifest (counts, timestamp, license, bbox)
v1/<CC>/cells/<latIdx>_<lngIdx>.json   one file per occupied cell (grid = 0.1°)
v1/<CC>/idx/<latBlock>_<lngBlock>.json one index per occupied 1° block
```

Cell ids are integers, so a client can compute them without a lookup table:

```
latIdx = floor((lat + 90) / 0.1)      // 50.8503 -> 1408
lngIdx = floor((lng + 180) / 0.1)     //  4.3517 -> 1843
cell   = 1408_1843        idx = 140_184     (1° block = floor(lat + 90), floor(lng + 180))
```

Example (Brussels): `/v1/BE/cells/1408_1843.json` and `/v1/BE/idx/140_184.json`.

## Cell schema (v1)

```json
{"v":1,"cell":"1408_1843","ts":"20261018T202506Z",
 "s":["","Central Station","Mo-Fr 08:00-20:00"],
 "p":[[123456,5085030,435170,0,1349,1,2,3,0]]}
```

| Field | Meaning |
| --- | --- |
| `s` | per-cell string table; **index 0 is always `""` = tag absent** |
| `p[]` | `[id, latE5, lngE5, cat, flags, name, hours, operator, image]` |
| `id` | OSM node id |
| `latE5` / `lngE5` | coordinate × 1e5 (~1.1 m precision) |
| `cat` | index into `categories` in `config/countries.json` (**fixed order — append only**) |
| `flags` | bitfield, documented machine-readably under `layout.flags` in `manifest.json` |
| `image` | string index; when bit 14 of `flags` is set the value is a Wikimedia Commons filename |

Flag semantics mirror the app's `parsePoiDetail()` exactly: wheelchair 0/1/2 =
unknown/yes/no; fee 0/1/2 = unknown/free/paid; access 0/1/2 = unknown/yes/no;
changing_table 0/1/2/3 = unknown/yes/limited/no; bottle, indoor 0/1/2 =
unknown/yes/no; stateofrepair 0/1/2 = unknown/ok/broken.

Only **nodes** are exported, and only the four filter categories. Waste baskets
and EV chargers stay on the live path by design.

## Adding a country

1. Set `"enabled": true` on its entry in `config/countries.json` (all EU-27 rows
   already exist with their Geofabrik paths; Czechia is `europe/czech-republic`).
2. Commit, then run the workflow once (Actions → *Build static POI data* → *Run
   workflow*) or wait for Monday 03:17 UTC.

Nothing else changes: the matrix, artifact names, deploy merge and root manifest
all derive from the config. Never reorder `categories` — `cat` is a positional
index; add new categories at the end.

## Pipeline internals

Per country the build job runs exactly this chain:

```sh
osmium tags-filter input.osm.pbf ${FILTERS} -o filtered.osm.pbf
osmium export filtered.osm.pbf -f geojsonseq -u type_id -o pois.geojsonseq
node scripts/split-cells.mjs --country <CC> --input pois.geojsonseq \
  --out dist/v1/<CC> --timestamp "$TS"
```

`-u type_id` is mandatory: without it `osmium export` omits the OSM id, and the
split step rejects every feature as id-less. `geojsonseq` records begin with an
ASCII record separator (0x1e), which `split-cells.mjs` strips.

## Manual run for one country

Actions → **Build static POI data** → **Run workflow** → `only` = `BE` (comma
separate for several, e.g. `BE,NL`). Empty `only` builds every enabled country.

A partial run does **not** delete other countries: the deploy job restores the
previously published set from the `data-latest` release asset, overlays the
freshly built countries, and rewrites the root manifest.

## Failure behaviour (no partial publishes)

* `fail-fast: false` — every country in the matrix is attempted, so one bad
  download does not hide the rest.
* The deploy job runs only when **all** matrix jobs succeeded. If any country
  fails, nothing is published and the live site keeps the previous complete
  dataset (last good data stays up).
* `merge-manifest.mjs` exits non-zero on any inconsistency (missing cell file,
  wrong category order, empty country), so a broken directory cannot be
  published.
* `split-cells.mjs` refuses to write an empty country.

## Hosting

GitHub Pages, source **GitHub Actions**. Public repo, no build minutes consumed
for Pages, no file-count limit below the 1 GB site cap. Rough sizes: Belgium is
~400 cell files / ~0.55 MB; the full EU-27 at 0.1° is ~21–22k files / ~31 MB.

## Local check (no OSM download needed)

`split-cells.mjs` reads `osmium export -f geojsonseq` output line by line:

```sh
node scripts/split-cells.mjs --country BE --input test.geojsonseq \
  --out dist/v1/BE --timestamp 2026-10-18T20:25:06Z

node scripts/merge-manifest.mjs --dir dist
```

## Known limits

* Nodes only. Toilets/AEDs mapped as building polygons (`way`) are not included;
  that is ~4–20 % of elements for toilets/ATMs and near zero for AEDs.
* `IE` covers Ireland **and Northern Ireland** (single Geofabrik extract);
  `FR` includes the overseas departments.
* GitHub disables `schedule` triggers after 60 days without repository activity.
  If the weekly data ever stops refreshing, run the workflow manually once (a
  release upload usually counts as activity, but that is not documented).
* ODbL: this repository republishes a filtered extract. Keep the attribution in
  `index.html`/README and ship the ODbL text (see `LICENSE`).
