import { z } from 'zod';
import {
  markdownImportCollections,
  MAX_MARKDOWN_IMPORT_BYTES,
  type MarkdownImportRequest,
} from './markdown-import';

export const markdownImportRequestSchema: z.ZodType<MarkdownImportRequest> = z.object({
  collection: z.enum(markdownImportCollections),
  filename: z.string().trim().min(1).max(255),
  source: z.string().min(1).max(MAX_MARKDOWN_IMPORT_BYTES),
  slug: z
    .string()
    .trim()
    .min(1, '请填写网址别名。')
    .max(64, '网址别名不能超过 64 个字符。')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, '网址别名只能使用小写英文、数字和中划线。'),
  title: z.string().trim().min(1, '请填写标题。').max(120),
  description: z.string().trim().max(300).optional().default(''),
  creator: z.string().trim().max(120).optional().default(''),
});
