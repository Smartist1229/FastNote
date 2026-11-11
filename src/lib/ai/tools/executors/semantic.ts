import * as semanticApi from "@/api/ai/semantic";
import type { Note } from "@/interface/note/note";
import { formatError } from "@/lib/ai/aiParse/text";
import { visibleNotes } from "../helpers";
import type { ToolExecutors } from "../types";

export const semanticExecutors: ToolExecutors = {
  searchNotesSemantic: async (args, ctx) => {
    const query = String(args.query ?? "").trim();
    if (!query) return { error: "query 不能为空" };
    // 未开启或模型没下载时直接说明，否则模型会反复换关键词重试
    try {
      const status = await semanticApi.getSemanticStatus();
      if (!status.enabled) {
        return {
          matches: [],
          total: 0,
          error: "语义搜索未开启",
          hint: "用户没有在设置里开启语义搜索。改用 searchNotes（精确关键词）或 listTags + findNotesByTag。",
        };
      }
      if (!status.model_ready) {
        return {
          matches: [],
          total: 0,
          error: "语义模型尚未下载",
          hint: "语义模型还没下载，无法按语义检索。改用 searchNotes 或 listTags + findNotesByTag。",
        };
      }
    } catch (e) {
      return {
        matches: [],
        total: 0,
        error: `无法读取语义搜索状态：${formatError(e)}`,
        hint: "改用 searchNotes 或 listTags + findNotesByTag。",
      };
    }

    // 权限过滤在 Rust 侧完成：只传可见笔记 id，受限笔记的标题与片段不会进入返回值
    const visible = await visibleNotes(ctx.access);
    const byId = new Map<string, Note>(visible.map((n) => [n.id, n]));
    if (byId.size === 0) return { matches: [], total: 0 };

    try {
      const hits = await semanticApi.semanticSearch(query, 15, [...byId.keys()]);
      const matches = hits
        .filter((hit) => byId.has(hit.note_id))
        .map((hit) => ({
          id: hit.note_id,
          title: byId.get(hit.note_id)!.title,
          content: hit.snippet,
          score: Number(hit.score.toFixed(4)),
        }));
      return {
        matches,
        total: matches.length,
        ...(matches.length === 0
          ? { hint: "没有语义命中。可以换一句更自然的描述，或改用 searchNotes / listTags + findNotesByTag。" }
          : {}),
      };
    } catch (e) {
      return {
        matches: [],
        total: 0,
        error: `语义检索失败：${formatError(e)}`,
        hint: "模型可能未就绪。改用 searchNotes 或 listTags + findNotesByTag。",
      };
    }
  },
};
