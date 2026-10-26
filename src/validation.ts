import { loadCase, suiteCases } from './config.ts';

export interface ValidationResult {
  checked: number;
  errors: string[];
}

// The same loader validates execution and authoring. No adapter, experiment or run output.
// A malformed manifest stops traversal; otherwise report the first error of every case.
export function validateSchema(casesDir: string, suite: string): ValidationResult {
  const result: ValidationResult = { checked: 0, errors: [] };
  try {
    for (const ref of suiteCases(casesDir, suite)) {
      result.checked++;
      try { loadCase(casesDir, suite, ref); }
      catch (error) { result.errors.push((error as Error).message); }
    }
  } catch (error) { result.errors.push((error as Error).message); }
  return result;
}
