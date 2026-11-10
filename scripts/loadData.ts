import { readFileSync, existsSync } from 'node:fs';
import type { MapData } from '../src/engine/types';
/** map + fixed bus lines (the app merges them the same way after fetching both files) */
export function loadData(dir = 'public/data'): MapData {
  const data: MapData = JSON.parse(readFileSync(`${dir}/dongda.json`, 'utf8'));
  if (existsSync(`${dir}/bus_lines.json`)) data.busLines = JSON.parse(readFileSync(`${dir}/bus_lines.json`, 'utf8')).lines;
  return data;
}
