/**
 * 编辑器节点清单 —— 创建 editor 时一次性传入
 *
 * 🔴 为什么必须是"一份清单"而不是各处现传：
 *   Lexical 0.52 要求所有可能被创建的节点都在 createEditor({nodes}) 里注册，
 *   少注册一个就在**运行时**抛 "Attempted to create node X that was not configured"。
 *   这个错在headless 单测里表现为"整篇文档变空"（update 回调中途抛，
 *   后续节点全丢），症状与"序列化写错了"一模一样 —— 极易误判。
 *   本文件是唯一清单，单测与生产共用，不会出现"测试过了线上炸"。
 */

import type { Klass, LexicalNode } from 'lexical';

import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { HorizontalRuleNode } from '@lexical/extension/HorizontalRuleExtension.js';
import { CUSTOM_NODES } from './nodes.ts';

/** 全量节点清单：Lexical 内置的 + 本项目自定义的 */
export const ALL_NODES = [
  // 内置
  HeadingNode,
  QuoteNode,
  CodeNode,
  LinkNode,
  ListNode,
  ListItemNode,
  HorizontalRuleNode,
  // 自定义
  ...CUSTOM_NODES,
] as const satisfies readonly Klass<LexicalNode>[];