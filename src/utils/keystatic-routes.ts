export interface KeystaticRouteContext {
  branch?: string;
}

function segment(value: string) {
  return encodeURIComponent(value);
}

export function getKeystaticBaseUrl({ branch }: KeystaticRouteContext = {}) {
  return branch ? `/keystatic/branch/${segment(branch)}` : '/keystatic';
}

export function getKeystaticCollectionUrl(collection: string, context: KeystaticRouteContext = {}) {
  return `${getKeystaticBaseUrl(context)}/collection/${segment(collection)}`;
}

export function getKeystaticCreateUrl(collection: string, context: KeystaticRouteContext = {}) {
  return `${getKeystaticCollectionUrl(collection, context)}/create`;
}

export function getKeystaticEntryUrl(
  collection: string,
  slug: string,
  context: KeystaticRouteContext = {},
) {
  return `${getKeystaticCollectionUrl(collection, context)}/item/${segment(slug)}`;
}

export function getKeystaticSingletonUrl(singleton: string, context: KeystaticRouteContext = {}) {
  return `${getKeystaticBaseUrl(context)}/singleton/${segment(singleton)}`;
}
