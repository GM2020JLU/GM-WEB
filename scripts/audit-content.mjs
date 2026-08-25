#!/usr/bin/env node
import process from 'node:process';
import { auditRepository } from './lib/content-audit.mjs';

const issues = auditRepository(process.cwd());
const errors = issues.filter((item) => item.level === 'error');
const warnings = issues.filter((item) => item.level === 'warning');

for (const item of issues) {
  const icon = item.level === 'error' ? '✗' : '△';
  console.log(`${icon} ${item.file.replace(`${process.cwd()}/`, '')}: ${item.message}`);
}
console.log(`内容检查：${errors.length} 个错误，${warnings.length} 个草稿提醒。`);
if (errors.length > 0) process.exitCode = 1;
