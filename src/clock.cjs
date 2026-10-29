// Fixed wall clock only. Real timers remain live so execution budgets still work.
const RealDate = Date;
const now = Number(process.env.AGENT_EVAL_NOW);
if (!Number.isFinite(now)) throw new Error('AGENT_EVAL_NOW must be a fixed epoch in milliseconds');
globalThis.Date = new Proxy(RealDate, {
  apply() { return new RealDate(now).toString(); },
  construct(target, args, receiver) { return Reflect.construct(target, args.length ? args : [now], receiver); },
  get(target, key) { return key === 'now' ? () => now : Reflect.get(target, key); },
});
