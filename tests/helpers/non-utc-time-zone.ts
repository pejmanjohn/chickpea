/**
 * Runs the importing test file nine hours ahead of UTC, so a date shown in
 * local time instead of its UTC day fails on every host, a UTC one included.
 * Import it first: modules can build their date formatters as they load.
 */
process.env.TZ = 'Asia/Tokyo';
