import { countWords, getContentHealth, getPublicationStatus } from './content-metrics';

export interface StudioAnalyticsEntry {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  body?: string;
}

export interface StudioAnalyticsModule {
  collection: string;
  label: string;
  total: number;
  published: number;
  ready: number;
  draft: number;
  issues: number;
  words: number;
}

export interface StudioAnalytics {
  total: number;
  published: number;
  ready: number;
  draft: number;
  issues: number;
  words: number;
  modules: StudioAnalyticsModule[];
}

const labels: Record<string, string> = {
  blog: '博客文章',
  projects: '项目案例',
  vibe: '随记',
  media: '书影音',
  about: '站点页面',
};

export function getStudioAnalytics(entries: StudioAnalyticsEntry[]): StudioAnalytics {
  const modules = Object.entries(labels).map(([collection, label]) => {
    const moduleEntries = entries.filter((entry) => entry.collection === collection);
    const module = {
      collection,
      label,
      total: moduleEntries.length,
      published: 0,
      ready: 0,
      draft: 0,
      issues: 0,
      words: 0,
    } satisfies StudioAnalyticsModule;

    for (const entry of moduleEntries) {
      const status = getPublicationStatus(entry.data);
      module[status] += 1;
      module.words += countWords(entry.body ?? '');
      if (getContentHealth(entry).length > 0) module.issues += 1;
    }
    return module;
  });

  const summary: StudioAnalytics = {
    total: 0,
    published: 0,
    ready: 0,
    draft: 0,
    issues: 0,
    words: 0,
    modules,
  };
  for (const module of modules) {
    summary.total += module.total;
    summary.published += module.published;
    summary.ready += module.ready;
    summary.draft += module.draft;
    summary.issues += module.issues;
    summary.words += module.words;
  }
  return summary;
}
