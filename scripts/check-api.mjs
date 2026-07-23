import { port } from "../server/config.mjs";

const response = await fetch(`http://127.0.0.1:${port}/api/flows?boardType=industry&flowType=main&limit=18`);
if (!response.ok) throw new Error(`flow API ${response.status}`);
const payload = await response.json();
const summary = {
  meta: payload.meta,
  seriesCount: payload.series.length,
  pointCount: payload.series.reduce((sum, series) => sum + series.points.length, 0),
  firstSeries: payload.series[0] ? {
    code: payload.series[0].code,
    name: payload.series[0].name,
    firstPoint: payload.series[0].points[0],
    lastPoint: payload.series[0].points.at(-1),
  } : null,
};
console.log(JSON.stringify(summary, null, 2));
if (!payload.series.length) process.exitCode = 1;
