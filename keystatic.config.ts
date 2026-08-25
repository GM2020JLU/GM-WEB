import {
  collection,
  config,
  fields,
  singleton,
  type BasicFormField,
  type FormFieldStoredValue,
} from '@keystatic/core';
import slugify from '@sindresorhus/slugify';
import { pinyin } from 'pinyin-pro';
import { createElement } from 'react';

const repository = {
  owner: 'GM2020JLU',
  name: 'GM-WEB',
} as const;

const requestedStorage = import.meta.env.PUBLIC_KEYSTATIC_STORAGE_KIND;
const isGitHubStorage =
  requestedStorage === 'github' || (requestedStorage !== 'local' && import.meta.env.PROD);

const editorOptions = {
  image: {
    directory: 'src/assets/images/content',
    publicPath: '@assets/images/content/',
  },
} as const;

function localIsoDateTime() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}

const publicationStatusOptions = [
  { label: '草稿', value: 'draft' },
  { label: '待发布', value: 'ready' },
  { label: '已发布', value: 'published' },
] as const;

const publicationStatus = fields.select({
  label: '发布状态',
  options: publicationStatusOptions,
  defaultValue: 'draft',
  description: '待发布内容会参与检查，只有已发布内容会出现在公开站点。',
});

function GouminBrandMark({ colorScheme }: { colorScheme: 'light' | 'dark' }) {
  const ink = colorScheme === 'dark' ? '#dce8df' : '#294331';
  const paper = colorScheme === 'dark' ? '#243128' : '#eef5ef';

  return createElement(
    'svg',
    {
      'aria-hidden': true,
      viewBox: '0 0 36 36',
      width: 32,
      height: 32,
      fill: 'none',
    },
    createElement('rect', { width: 36, height: 36, rx: 11, fill: ink }),
    createElement('path', {
      d: 'M11 23.5V12.8c0-1 .8-1.8 1.8-1.8H24l-2.7 3H15v6.3h4.2v-3h3.6v6.5c-1.8 1.1-3.8 1.7-6 1.7-2.3 0-4.2-.7-5.8-2Z',
      fill: paper,
    }),
    createElement('path', {
      d: 'M23.5 8.5c1.8 2.7 1.5 5.2-.8 7.5-.4-2.4-1.6-4.1-3.6-5.1 1.4-1.3 2.9-2.1 4.4-2.4Z',
      fill: '#86b891',
    }),
  );
}

function autoUpdatedDate(): BasicFormField<string> {
  const parse = (value: FormFieldStoredValue) => (typeof value === 'string' ? value : '');

  return {
    kind: 'form',
    label: '自动更新时间',
    Input: () => null,
    defaultValue: localIsoDateTime,
    parse,
    serialize: () => ({ value: localIsoDateTime() }),
    validate: (value) => value,
    reader: { parse },
  };
}

function chinaDateTime(label: string, description?: string): BasicFormField<string> {
  const field = fields.datetime({ label, description, validation: { isRequired: true } });
  const parseEditorValue = (value: FormFieldStoredValue) =>
    typeof value === 'string' ? value.slice(0, 16) : '';

  return {
    ...field,
    defaultValue: () => localIsoDateTime().slice(0, 16),
    parse: parseEditorValue,
    serialize: (value) => ({ value: value ? `${value}:00+08:00` : undefined }),
    reader: {
      parse: (value) => (typeof value === 'string' ? value : ''),
    },
  };
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

const taxonomyTitle = fields.slug({
  name: {
    label: '名称',
    validation: { isRequired: true },
  },
  slug: {
    label: '标识',
    description: '保持与名称一致，建立后尽量不要修改。',
    generate: (value) => value.trim().replace(/[\\/]/g, '-').slice(0, 64),
    validation: {
      pattern: {
        regex: /^[^\\/]+$/u,
        message: '不能包含路径分隔符。',
      },
    },
  },
});

const taxonomyCollection = (label: string, path: `${string}/*`) =>
  collection({
    label,
    path,
    slugField: 'title',
    columns: ['title'],
    format: 'yaml',
    schema: {
      title: taxonomyTitle,
      description: fields.text({ label: '说明', multiline: true }),
    },
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
  date: chinaDateTime('发布时间', '用于公开页面排序和展示，保存时自动写入东八区。'),
  updatedDate: autoUpdatedDate(),
  publicationStatus,
  draft: fields.ignored(),
  sticky: fields.ignored(),
  heroImage: fields.image({
    label: '封面图',
    directory: 'src/assets/images/content',
    publicPath: '@assets/images/content/',
    description: '上传后会按内容网址分目录保存。',
  }),
  heroImageAlt: fields.text({ label: '封面图替代文本', description: '封面包含信息时必填。' }),
  showHeroImage: fields.checkbox({ label: '在文章页显示封面', defaultValue: true }),
  tags: fields.multiRelationship({
    label: '标签',
    collection: 'tags',
    description: '描述具体技术或主题，可以选择多个。',
  }),
  categories: fields.multiRelationship({
    label: '分类',
    collection: 'categories',
    description: '文章所属的主要栏目，通常只选一个。',
  }),
  series: fields.multiRelationship({
    label: '系列',
    collection: 'series',
    description: '只有连续文章需要选择系列。',
  }),
  comments: fields.checkbox({ label: '开启评论', defaultValue: true }),
  sidebar,
  body: fields.mdx({
    label: '正文',
    extension,
    options: editorOptions,
  }),
});

const projects = collection({
  label: '项目案例',
  path: 'src/content/projects/*',
  slugField: 'title',
  entryLayout: 'content',
  previewUrl: '/preview/projects/{slug}',
  columns: ['publicationStatus', 'date', 'updatedDate'],
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
    brand: { name: 'Gou Min · 创作后台', mark: GouminBrandMark },
    navigation: {
      创作与发布: ['blog', 'vibe', 'projects', 'media'],
      站点页面: ['about'],
      内容组织: ['categories', 'series', 'tags'],
    },
  },
  collections: {
    blog: collection({
      label: '博客 · 长文',
      path: 'src/content/blog/*',
      slugField: 'title',
      entryLayout: 'content',
      previewUrl: '/preview/blog/{slug}',
      columns: ['publicationStatus', 'date', 'updatedDate'],
      format: { data: 'yaml', contentField: 'body' },
      schema: {
        title: slugTitle(),
        ...commonArticleFields('md'),
      },
    }),
    projects,
    vibe: collection({
      label: '随记 · 短内容',
      path: 'src/content/vibe/*',
      slugField: 'title',
      entryLayout: 'content',
      previewUrl: '/preview/vibe/{slug}',
      columns: ['publicationStatus', 'date', 'updatedDate'],
      format: { data: 'yaml', contentField: 'body' },
      schema: {
        title: slugTitle('标题（可简短概括）'),
        date: chinaDateTime('发布时间', '保存时自动写入东八区。'),
        updatedDate: autoUpdatedDate(),
        publicationStatus,
        draft: fields.ignored(),
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
        images: fields.array(
          fields.image({
            label: '图片',
            directory: 'src/assets/images/content',
            publicPath: '@assets/images/content/',
          }),
          { label: '图片', itemLabel: () => '图片' },
        ),
        tags: fields.multiRelationship({
          label: '标签',
          collection: 'tags',
          description: '选择已有标签；新标签请先到“内容组织”建立。',
        }),
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
    media: collection({
      label: '书影音记录',
      path: 'src/content/media/*',
      slugField: 'title',
      columns: ['publicationStatus', 'type', 'status'],
      previewUrl: '/preview/media/{slug}',
      format: { data: 'yaml', contentField: 'body' },
      schema: {
        title: slugTitle(),
        creator: fields.text({ label: '创作者', validation: { isRequired: true } }),
        publicationStatus,
        draft: fields.ignored(),
        updatedDate: autoUpdatedDate(),
        type: fields.select({
          label: '类型',
          defaultValue: 'book',
          options: [
            { label: '书籍', value: 'book' },
            { label: '电影', value: 'film' },
            { label: '剧集', value: 'series' },
            { label: '专辑', value: 'album' },
            { label: '播客', value: 'podcast' },
          ],
        }),
        status: fields.select({
          label: '进度',
          defaultValue: 'completed',
          options: [
            { label: '已完成', value: 'completed' },
            { label: '进行中', value: 'in-progress' },
            { label: '计划中', value: 'planned' },
            { label: '已放弃', value: 'abandoned' },
          ],
        }),
        completedAt: fields.date({ label: '完成日期' }),
        cover: fields.image({
          label: '封面',
          directory: 'src/assets/images/content',
          publicPath: '@assets/images/content/',
        }),
        coverAspect: fields.select({
          label: '封面比例',
          defaultValue: 'portrait',
          options: [
            { label: '竖版', value: 'portrait' },
            { label: '横版', value: 'landscape' },
            { label: '方形', value: 'square' },
            { label: '宽幅', value: 'wide' },
          ],
        }),
        rating: fields.number({ label: '评分', validation: { min: 1, max: 5 } }),
        review: fields.checkbox({ label: '显示长评', defaultValue: false }),
        tags: fields.multiRelationship({
          label: '标签',
          collection: 'tags',
          description: '选择已有标签；新标签请先到“内容组织”建立。',
        }),
        externalUrl: fields.url({ label: '外部链接' }),
        body: fields.mdx({ label: '评论', extension: 'md', options: editorOptions }),
      },
    }),
    categories: taxonomyCollection('分类', 'src/content/taxonomies/categories/*'),
    series: taxonomyCollection('系列', 'src/content/taxonomies/series/*'),
    tags: taxonomyCollection('标签', 'src/content/taxonomies/tags/*'),
  },
  singletons: {
    about: singleton({
      label: '关于我',
      path: 'src/content/about',
      entryLayout: 'content',
      previewUrl: '/preview/about',
      format: { data: 'yaml', contentField: 'body' },
      schema: {
        title: fields.text({ label: '标题', validation: { isRequired: true } }),
        ...commonArticleFields('mdx'),
      },
    }),
  },
});
