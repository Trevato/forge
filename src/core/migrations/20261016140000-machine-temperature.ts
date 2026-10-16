// What the machine's thermometers said (#2081, boards/thermal.ts): °C for
// each logical CPU (`cpu:<n>`) and every other hwmon sensor, beside the
// CPU and memory columns of 0088 — the 15-s reading, or the 5-min mean
// and max. Telemetry, not state: a lost row is a gap in a chart.
export default `
  ALTER TABLE machine_sample ADD COLUMN celsius REAL;
  ALTER TABLE machine_sample ADD COLUMN celsius_max REAL;
  `;
