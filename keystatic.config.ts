import { collection, config, fields, singleton } from '@keystatic/core';
import slugify from '@sindresorhus/slugify';
import { pinyin } from 'pinyin-pro';

const repository = {
  owner: 'GM2020JLU',
  name: 'GM-WEB',
} as const;

const requestedStorage = process.env.KEYSTATIC_STORAGE_KIND;
const isGitHubStorage =
  requestedStorage === 'github' ||
  (requestedStorage !== 'local' &&
    (process.env.VERCEL === '1' || process.env.NODE_ENV === 'production'));

const editorOptions = {
  image: {
    directory: 'src/assets/images/content',
    publicPath: '@assets/images/content/',
  },
} as const;

const isoDateTimePattern = {
  regex: /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/,
  message: '请使用 YYYY-MM-DD 或带时区的 ISO 8601 时间。',
};

function localIsoDateTime() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}

function stableSlug(title: string) {
  return slugify(
    pinyin(title, {
      toneType: 'none',
      nonZh: 'consecutive',
      separator: ' ',
    }),
  ).slice(0, 64);
}

const slugTitle = (label = '标题') =>
  fields.slug({
    name: {
      label,
      validation: { isRequired: true },
    },
    slug: {
      label: '网址别名',
      description: '用于文件名和网址，保存后尽量不要修改。',
      generate: stableSlug,
      validation: {
        pattern: {
          regex: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          message: '只能使用小写英文、数字和中划线。',
        },
      },
    },
  });

const textList = (label: string, itemLabel: string) =>
  fields.array(fields.text({ label: itemLabel }), {
    label,
    itemLabel: ({ value }) => value || itemLabel,
  });

const sidebar = fields.object(
  {
    enable: fields.checkbox({ label: '显示侧边栏', defaultValue: true }),
    toc: fields.checkbox({ label: '显示目录', defaultValue: true }),
    relatedPosts: fields.checkbox({ label: '显示相关文章', defaultValue: true }),
  },
  {
    label: '侧边栏',
    description: '控制文章页右侧的导航内容。',
    layout: [4, 4, 4],
  },
);

const commonArticleFields = (extension: 'md' | 'mdx') => ({
  description: fields.text({
    label: '摘要',
    multiline: true,
    validation: { isRequired: true },
    description: '用于列表卡片和搜索引擎摘要。',
  }),
  date: fields.text({
    label: '发布时间',
    defaultValue: localIsoDateTime,
    validation: { isRequired: true, pattern: isoDateTimePattern },
    description: '保留完整时区，例如 2026-08-23T12:30:00+08:00。',
  }),
  draft: fields.checkbox({
    label: '草稿',
    defaultValue: true,
    description: '草稿不会出现在生产站点中。',
  }),
  sticky: fields.ignored(),
  heroImage: fields.text({
    label: '封面图路径',
    description: '可填 Astro 资源路径或 https:// 远程图片，留空表示不设置。',
  }),
  showHeroImage: fields.checkbox({ label: '在文章页显示封面', defaultValue: true }),
  tags: textList('标签', '标签'),
  categories: textList('分类', '分类'),
  series: textList('系列', '系列'),
  comments: fields.checkbox({ label: '开启评论', defaultValue: true }),
  sidebar,
  body: fields.mdx({
    label: '正文',
    extension,
    options: editorOptions,
  }),
});

const projects = collection({
  label: '项目',
  path: 'src/content/projects/*',
  slugField: 'title',
  entryLayout: 'content',
  format: { data: 'yaml', contentField: 'body' },
  schema: {
    title: slugTitle(),
    ...commonArticleFields('mdx'),
    icon: fields.select({
      label: '图标',
      defaultValue: 'github',
      options: [
        { label: 'GitHub', value: 'github' },
        { label: '盒子', value: 'box' },
        { label: '代码', value: 'code-2' },
        { label: '数据库', value: 'database' },
        { label: '代码文件', value: 'file-code-2' },
        { label: '网站', value: 'globe-2' },
        { label: '分层', value: 'layers-3' },
        { label: '设计', value: 'palette' },
        { label: '火箭', value: 'rocket' },
        { label: '灵感', value: 'sparkles' },
        { label: '终端', value: 'terminal' },
        { label: '魔法', value: 'wand-sparkles' },
      ],
    }),
    iconColor: fields.text({
      label: '图标颜色',
      description: '支持颜色名、#RRGGBB 或 var(--css-variable)。',
    }),
    authors: fields.array(
      fields.object(
        {
          name: fields.text({ label: '姓名', validation: { isRequired: true } }),
          url: fields.url({ label: '个人链接' }),
        },
        { label: '作者', layout: [6, 6] },
      ),
      {
        label: '作者',
        itemLabel: ({ fields }) => fields.name.value || '作者',
      },
    ),
    links: fields.array(
      fields.object(
        {
          label: fields.text({ label: '文字', validation: { isRequired: true } }),
          href: fields.url({ label: '网址', validation: { isRequired: true } }),
          kind: fields.select({
            label: '类型',
            defaultValue: 'website',
            options: [
              { label: 'GitHub', value: 'github' },
              { label: '网站', value: 'website' },
              { label: '平台', value: 'platform' },
              { label: '文档', value: 'docs' },
              { label: '演示', value: 'demo' },
            ],
          }),
        },
        { label: '项目链接', layout: [3, 6, 3] },
      ),
      {
        label: '项目链接',
        itemLabel: ({ fields }) => fields.label.value || '项目链接',
      },
    ),
  },
});

export default config({
  storage: isGitHubStorage ? { kind: 'github', repo: repository } : { kind: 'local' },
  locale: 'zh-CN',
  ui: {
    brand: { name: 'Gou Min 写作后台' },
    navigation: {
      写作: ['blog', 'vibe'],
      展示: ['projects'],
      页面: ['about'],
    },
  },
  collections: {
    blog: collection({
      label: '博客文章',
      path: 'src/content/blog/*',
      slugField: 'title',
      entryLayout: 'content',
      format: { data: 'yaml', contentField: 'body' },
      schema: {
        title: slugTitle(),
        ...commonArticleFields('md'),
      },
    }),
    projects,
    vibe: collection({
      label: '随记',
      path: 'src/content/vibe/*',
      slugField: 'title',
      entryLayout: 'content',
      format: { data: 'yaml', contentField: 'body' },
      schema: {
        title: slugTitle('标题（可简短概括）'),
        date: fields.text({
          label: '发布时间',
          defaultValue: localIsoDateTime,
          validation: { isRequired: true, pattern: isoDateTimePattern },
          description: '保留完整时区，例如 2026-08-23T12:30:00+08:00。',
        }),
        updatedDate: fields.text({
          label: '更新时间',
          validation: { pattern: isoDateTimePattern },
          description: '未更新时可留空。',
        }),
        draft: fields.checkbox({ label: '草稿', defaultValue: true }),
        type: fields.select({
          label: '类型',
          defaultValue: 'text',
          options: [
            { label: '文字', value: 'text' },
            { label: '图片', value: 'photo' },
            { label: '引语', value: 'quote' },
            { label: '代码', value: 'code' },
            { label: '混合', value: 'mixed' },
          ],
        }),
        mood: fields.text({ label: '心情' }),
        location: fields.text({ label: '地点' }),
        images: textList('图片路径', '图片路径或 https:// 网址'),
        tags: textList('标签', '标签'),
        align: fields.select({
          label: '对齐',
          defaultValue: 'left',
          options: [
            { label: '左对齐', value: 'left' },
            { label: '右对齐', value: 'right' },
            { label: '居中', value: 'center' },
          ],
        }),
        size: fields.select({
          label: '卡片大小',
          defaultValue: 'md',
          options: [
            { label: '小', value: 'sm' },
            { label: '中', value: 'md' },
            { label: '大', value: 'lg' },
          ],
        }),
        body: fields.mdx({ label: '正文', extension: 'md', options: editorOptions }),
      },
    }),
  },
  singletons: {
    about: singleton({
      label: '关于我',
      path: 'src/content/about',
      entryLayout: 'content',
      format: { data: 'yaml', contentField: 'body' },
      schema: {
        title: fields.text({ label: '标题', validation: { isRequired: true } }),
        ...commonArticleFields('mdx'),
      },
    }),
  },
});
