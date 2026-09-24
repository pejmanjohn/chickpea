// Stands in for tsc in tests/run-tests.test.ts: reports one error and fails.
setTimeout(() => {
  console.log("src/example.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.");
  process.exit(2);
}, 200);
