// An empty pointer selects the document. Bare names retain E4a's `answer` syntax.
export function validField(field: unknown): field is string {
  return typeof field === 'string' && (field === '' || (!field.startsWith('/') && !field.includes('/'))
    || (field.startsWith('/') && !/~(?![01])/u.test(field)));
}

export function selectField(document: unknown, field: string): { found: boolean; value: unknown } {
  const tokens = field === '' ? [] : field.startsWith('/')
    ? field.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~')) : [field];
  let value = document;
  for (const token of tokens) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, token)
      || (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(token))) return { found: false, value: null };
    value = (value as Record<string, unknown>)[token];
  }
  return { found: true, value };
}

export function projectFields(document: unknown, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map(field => [field, selectField(document, field).value]));
}
