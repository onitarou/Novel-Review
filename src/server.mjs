import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  COMMENT_STATUS,
  STORY_STATUS,
  createChapter,
  createComment,
  createCommentReply,
  createStory,
  createWork,
  deleteCommentByReader,
  deleteCommentReply,
  deleteCommentReplyByReader,
  exportSnapshot,
  getActiveShareLink,
  getComment,
  getCommentReply,
  getCurrentVersion,
  getShareByToken,
  getStory,
  getWork,
  initDb,
  issueShareLink,
  listChapters,
  listCommentReplies,
  listWorks,
  listCommentsForAdmin,
  listReaderComments,
  listStoriesForAdmin,
  listStoriesForReader,
  listVersions,
  makeId,
  publishStory,
  regenerateShareLink,
  revokeShareLink,
  updateCommentByReader,
  updateCommentReply,
  updateCommentReplyByReader,
  updateCommentStatus,
  updateStoryDraft,
  updateWork
} from "./db.mjs";
import { escapeHtml, renderNovelMarkup } from "./markup.mjs";

const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (IS_PRODUCTION ? "" : "novel-admin");
const APP_SECRET = process.env.APP_SECRET || (IS_PRODUCTION ? "" : "dev-secret-change-me");
const PUBLIC_ORIGIN = normalizePublicOrigin(process.env.PUBLIC_ORIGIN || "");
const ADMIN_SESSION_MAX_AGE = 60 * 60 * 12;
const CSRF_COOKIE_NAME = "csrf_seed";
const CSRF_MAX_AGE = 60 * 60 * 24 * 7;
const READER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const publicDir = path.join(process.cwd(), "public");

assertRuntimeConfig();
await initDb();

const server = http.createServer(async (req, res) => {
  let pathname = "";

  try {
    const url = new URL(req.url, "http://localhost");
    pathname = decodeURIComponent(url.pathname);

    if (await serveStatic(pathname, res)) return;

    if (req.method === "POST") {
      const form = await readForm(req);
      if (!verifyCsrf(req, form)) {
        return forbidden(res, "フォームの有効期限が切れた可能性があります。ページを再読み込みしてから再度お試しください。");
      }
    }

    if (req.method === "GET" && pathname === "/") {
      redirect(res, "/admin/works");
      return;
    }

    if (pathname === "/admin/login") {
      if (req.method === "GET") return renderAdminLogin(req, res);
      if (req.method === "POST") return handleAdminLogin(req, res);
    }

    if (pathname === "/admin/logout" && req.method === "POST") {
      addCookie(res, cookieHeader(req, "admin_session", "", { maxAge: 0, httpOnly: true }));
      redirect(res, "/admin/login");
      return;
    }

    if (pathname.startsWith("/admin")) {
      if (!isAdmin(req)) {
        redirect(res, "/admin/login");
        return;
      }
      return await routeAdmin(req, res, url, pathname);
    }

    if (pathname.startsWith("/s/")) {
      return await routeReader(req, res, url, pathname);
    }

    notFound(res);
  } catch (error) {
    console.error("Unhandled request error", {
      method: req.method,
      path: pathname,
      error
    });
    renderHtml(res, 500, page("エラー", `
      <section class="panel">
        <h1>エラー</h1>
        <p>処理中に問題が発生しました。</p>
      </section>
    `));
  }
});

server.listen(PORT, () => {
  console.log(`Novel circle share app running at http://localhost:${PORT}`);
  console.log(`Sample reader URL: http://localhost:${PORT}/s/sample-share`);
});

async function routeAdmin(req, res, url, pathname) {
  if (req.method === "GET" && pathname === "/admin/works") {
    return renderAdminWorks(req, res);
  }

  if (req.method === "POST" && pathname === "/admin/works") {
    const form = await readForm(req);
    const title = required(form, "title");
    const workId = await createWork({
      title,
      synopsis: form.get("synopsis") || "",
      authorNote: form.get("author_note") || ""
    });
    redirect(res, `/admin/works/${workId}`);
    return;
  }

  if (req.method === "GET" && pathname === "/admin/comments") {
    return renderAdminComments(req, res);
  }

  if (req.method === "GET" && pathname === "/admin/export") {
    const snapshot = await exportSnapshot();
    res.writeHead(200, securityHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="novel-share-backup-${Date.now()}.json"`,
      "Cache-Control": "no-store"
    }));
    res.end(JSON.stringify(snapshot, null, 2));
    return;
  }

  let match = pathname.match(/^\/admin\/comments\/([^/]+)\/status$/);
  if (match && req.method === "POST") {
    const form = await readForm(req);
    await updateCommentStatus(match[1], form.get("status"));
    redirect(res, safeAdminRedirect(form.get("redirect_to")) || "/admin/comments");
    return;
  }

  match = pathname.match(/^\/admin\/comments\/([^/]+)\/replies$/);
  if (match && req.method === "POST") {
    const form = await readForm(req);
    const comment = await getComment(match[1]);
    if (!comment || comment.deleted_at) return notFound(res);

    await createCommentReply(match[1], {
      senderRole: "author",
      senderName: "投稿者",
      body: required(form, "body")
    });
    redirect(res, safeAdminRedirect(form.get("redirect_to")) || "/admin/comments");
    return;
  }

  match = pathname.match(/^\/admin\/comment-replies\/([^/]+)\/(edit|delete)$/);
  if (match && req.method === "POST") {
    const form = await readForm(req);
    const reply = await getCommentReply(match[1]);
    if (!reply || reply.deleted_at || reply.comment_deleted_at) return notFound(res);

    if (match[2] === "edit") {
      await updateCommentReply(match[1], required(form, "body"));
    } else {
      await deleteCommentReply(match[1]);
    }
    redirect(res, safeAdminRedirect(form.get("redirect_to")) || "/admin/comments");
    return;
  }

  match = pathname.match(/^\/admin\/works\/([^/]+)$/);
  if (match && req.method === "GET") {
    return renderAdminWork(req, res, match[1], url);
  }

  if (match && req.method === "POST") {
    const form = await readForm(req);
    await updateWork(match[1], {
      title: required(form, "title"),
      synopsis: form.get("synopsis") || "",
      authorNote: form.get("author_note") || ""
    });
    redirect(res, `/admin/works/${match[1]}`);
    return;
  }

  match = pathname.match(/^\/admin\/works\/([^/]+)\/chapters$/);
  if (match && req.method === "POST") {
    const form = await readForm(req);
    await createChapter(match[1], {
      title: required(form, "title"),
      sortOrder: Number(form.get("sort_order")) || 0
    });
    redirect(res, `/admin/works/${match[1]}`);
    return;
  }

  match = pathname.match(/^\/admin\/works\/([^/]+)\/stories$/);
  if (match && req.method === "POST") {
    const form = await readForm(req);
    const storyId = await createStory(match[1], {
      title: required(form, "title"),
      chapterId: form.get("chapter_id") || null,
      sortOrder: Number(form.get("sort_order")) || 0
    });
    redirect(res, `/admin/stories/${storyId}`);
    return;
  }

  match = pathname.match(/^\/admin\/works\/([^/]+)\/share\/issue$/);
  if (match && req.method === "POST") {
    const result = await issueShareLink(match[1]);
    const suffix = result.token ? `?shareToken=${encodeURIComponent(result.token)}` : "";
    redirect(res, `/admin/works/${match[1]}${suffix}`);
    return;
  }

  match = pathname.match(/^\/admin\/works\/([^/]+)\/share\/revoke$/);
  if (match && req.method === "POST") {
    await revokeShareLink(match[1], "manual");
    redirect(res, `/admin/works/${match[1]}`);
    return;
  }

  match = pathname.match(/^\/admin\/works\/([^/]+)\/share\/regenerate$/);
  if (match && req.method === "POST") {
    const result = await regenerateShareLink(match[1]);
    const suffix = result.token ? `?shareToken=${encodeURIComponent(result.token)}` : "";
    redirect(res, `/admin/works/${match[1]}${suffix}`);
    return;
  }

  match = pathname.match(/^\/admin\/stories\/([^/]+)$/);
  if (match && req.method === "GET") {
    return renderAdminStory(req, res, match[1], url);
  }

  match = pathname.match(/^\/admin\/stories\/([^/]+)\/draft$/);
  if (match && req.method === "POST") {
    const form = await readForm(req);
    await updateStoryDraft(match[1], storyForm(form));
    redirect(res, `/admin/stories/${match[1]}?saved=1`);
    return;
  }

  match = pathname.match(/^\/admin\/stories\/([^/]+)\/publish$/);
  if (match && req.method === "POST") {
    const form = await readForm(req);
    const result = await publishStory(match[1], {
      ...storyForm(form),
      changeNote: form.get("change_note") || ""
    });
    const version = result ? result.versionNumber : "";
    redirect(res, `/admin/stories/${match[1]}?published=${version}`);
    return;
  }

  notFound(res);
}

async function routeReader(req, res, url, pathname) {
  const replyMatch = pathname.match(/^\/s\/([^/]+)\/comment-replies\/([^/]+)\/(edit|delete)$/);
  const match = pathname.match(/^\/s\/([^/]+)(?:\/stories\/([^/]+))?(?:\/comments\/([^/]+)\/(edit|delete|replies))?$/);
  if (!match && !replyMatch) return notFound(res);

  const token = replyMatch ? replyMatch[1] : match[1];
  const storyId = match?.[2] || null;
  const commentId = match?.[3] || null;
  const commentAction = match?.[4] || null;
  const replyId = replyMatch?.[2] || null;
  const replyAction = replyMatch?.[3] || null;
  const share = await getShareByToken(token);

  if (!share) {
    renderHtml(res, 404, page("共有URLが無効です", `
      <section class="panel narrow">
        <h1>共有URLが無効です</h1>
        <p>このURLは停止されたか、再発行されています。</p>
      </section>
    `));
    return;
  }

  const readerId = ensureReaderId(req, res);

  if (replyId && req.method === "POST") {
    const form = await readForm(req);
    const reply = await getCommentReply(replyId);
    if (
      !reply ||
      reply.deleted_at ||
      reply.comment_deleted_at ||
      reply.work_id !== share.work_id ||
      reply.sender_role !== "reader" ||
      reply.reader_id !== readerId
    ) {
      return notFound(res);
    }

    if (replyAction === "edit") {
      await updateCommentReplyByReader(replyId, readerId, required(form, "body"));
    } else {
      await deleteCommentReplyByReader(replyId, readerId);
    }
    redirect(res, `/s/${token}/stories/${reply.story_id}?comment=${reply.comment_id}`);
    return;
  }

  if (replyId) {
    return notFound(res);
  }

  if (!storyId && req.method === "GET") {
    return renderReaderWork(req, res, token, share);
  }

  if (storyId && !commentId && req.method === "GET") {
    return renderReaderStory(req, res, url, token, share, storyId, readerId);
  }

  if (storyId && !commentId && req.method === "POST") {
    const form = await readForm(req);
    const story = await getReadableStory(share.work_id, storyId);
    if (!story) return notFound(res);
    const version = await getCurrentVersion(storyId);
    if (!version) return notFound(res);

    const commentId = await createComment({
      workId: share.work_id,
      storyId,
      storyVersionId: version.id,
      readerId,
      readerName: form.get("reader_name") || "匿名",
      body: required(form, "body"),
      quoteText: form.get("quote_text") || "",
      quoteStart: form.get("quote_start"),
      quoteEnd: form.get("quote_end"),
      quoteContextBefore: form.get("quote_context_before") || "",
      quoteContextAfter: form.get("quote_context_after") || ""
    });
    redirect(res, `/s/${token}/stories/${storyId}?comment=${commentId}`);
    return;
  }

  if (commentId && commentAction === "edit" && req.method === "POST") {
    const form = await readForm(req);
    const comment = await getComment(commentId);
    if (!comment || comment.work_id !== share.work_id || comment.reader_id !== readerId) {
      return notFound(res);
    }
    await updateCommentByReader(commentId, readerId, required(form, "body"));
    redirect(res, `/s/${token}/stories/${comment.story_id}?comment=${commentId}`);
    return;
  }

  if (commentId && commentAction === "replies" && req.method === "POST") {
    const form = await readForm(req);
    const comment = await getComment(commentId);
    if (!comment || comment.deleted_at || comment.work_id !== share.work_id || comment.reader_id !== readerId) {
      return notFound(res);
    }

    await createCommentReply(commentId, {
      senderRole: "reader",
      senderName: comment.reader_name,
      readerId,
      body: required(form, "body")
    });
    redirect(res, `/s/${token}/stories/${comment.story_id}?comment=${commentId}`);
    return;
  }

  if (commentId && commentAction === "delete" && req.method === "POST") {
    const comment = await getComment(commentId);
    if (!comment || comment.work_id !== share.work_id || comment.reader_id !== readerId) {
      return notFound(res);
    }
    await deleteCommentByReader(commentId, readerId);
    redirect(res, `/s/${token}/stories/${comment.story_id}`);
    return;
  }

  notFound(res);
}

function renderAdminLogin(req, res) {
  renderHtml(res, 200, page("管理者ログイン", `
    <section class="login-view">
      <div class="brand-panel">
        <p class="eyebrow">Novel critique workspace</p>
        <h1>小説共有</h1>
        <p>限定URLで作品を渡し、本文に紐づくコメントを受け取るための管理画面です。</p>
      </div>
      <form class="panel login-form" method="post" action="/admin/login">
        <h2>管理者ログイン</h2>
        <label>
          パスワード
          <input type="password" name="password" autocomplete="current-password" required autofocus>
        </label>
        <button class="primary" type="submit">ログイン</button>
      </form>
    </section>
  `, "", req, res));
}

async function handleAdminLogin(req, res) {
  const form = await readForm(req);
  if (form.get("password") === ADMIN_PASSWORD) {
    addCookie(res, cookieHeader(req, "admin_session", makeAdminSession(), {
      maxAge: ADMIN_SESSION_MAX_AGE,
      httpOnly: true
    }));
    redirect(res, "/admin/works");
    return;
  }

  renderHtml(res, 401, page("管理者ログイン", `
    <section class="panel narrow">
      <h1>ログインできません</h1>
      <p>パスワードを確認してください。</p>
      <a class="button" href="/admin/login">戻る</a>
    </section>
  `));
}

async function renderAdminWorks(req, res) {
  const works = await listWorks();
  const rows = works.map((work) => `
    <tr>
      <td><a href="/admin/works/${work.id}">${escapeHtml(work.title)}</a></td>
      <td>${work.unread_count}</td>
      <td>${work.active_share_count ? "有効" : "停止中"}</td>
      <td>${formatDate(work.updated_at)}</td>
    </tr>
  `).join("");

  renderHtml(res, 200, adminPage("作品一覧", `
    <header class="page-header">
      <div>
        <p class="eyebrow">Admin</p>
        <h1>作品一覧</h1>
      </div>
      <a class="button" href="/admin/comments">コメント一覧</a>
    </header>

    <section class="panel">
      <h2>新しい作品</h2>
      <form class="grid-form" method="post" action="/admin/works">
        <label>
          タイトル
          <input name="title" required maxlength="120">
        </label>
        <label>
          あらすじ
          <textarea name="synopsis" maxlength="1000" rows="3"></textarea>
        </label>
        <label>
          作者メモ
          <textarea name="author_note" rows="3"></textarea>
        </label>
        <button class="primary" type="submit">作成</button>
      </form>
    </section>

    <section class="panel">
      <h2>作品</h2>
      <table>
        <thead>
          <tr><th>タイトル</th><th>未読</th><th>共有URL</th><th>更新</th></tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="4">作品がありません。</td></tr>`}</tbody>
      </table>
    </section>
  `, req, res));
}

async function renderAdminWork(req, res, workId, url) {
  const work = await getWork(workId);
  if (!work) return notFound(res);

  const chapters = await listChapters(workId);
  const stories = await listStoriesForAdmin(workId);
  const comments = await listCommentsForAdmin({ workId });
  const activeShare = await getActiveShareLink(workId);
  const shareToken = normalizeShareToken(url.searchParams.get("shareToken"));
  const issuedShareUrl = shareToken ? publicUrl(`/s/${encodeURIComponent(shareToken)}`) : "";
  const chapterOptions = chapters.map((chapter) => (
    `<option value="${chapter.id}">${escapeHtml(chapter.title)}</option>`
  )).join("");

  const storyRows = stories.map((story) => `
    <tr>
      <td><a href="/admin/stories/${story.id}">${escapeHtml(story.title)}</a></td>
      <td>${escapeHtml(story.chapter_title || "章なし")}</td>
      <td><span class="status">${STORY_STATUS[story.status]}</span></td>
      <td>ver${story.current_version_number || "-"}</td>
      <td>${story.sort_order}</td>
    </tr>
  `).join("");

  renderHtml(res, 200, adminPage(work.title, `
    <header class="page-header">
      <div>
        <p class="eyebrow">Work</p>
        <h1>${escapeHtml(work.title)}</h1>
      </div>
      <a class="button" href="/admin/works">作品一覧</a>
    </header>

    ${shareToken ? `
      <section class="notice">
        <strong>共有URLを発行しました。</strong>
        <a href="${escapeAttr(issuedShareUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(issuedShareUrl)}</a>
      </section>
    ` : ""}

    <section class="panel">
      <h2>作品情報</h2>
      <form class="grid-form" method="post" action="/admin/works/${work.id}">
        <label>
          タイトル
          <input name="title" value="${escapeAttr(work.title)}" required maxlength="120">
        </label>
        <label>
          あらすじ
          <textarea name="synopsis" maxlength="1000" rows="4">${escapeHtml(work.synopsis)}</textarea>
        </label>
        <label>
          作者メモ
          <textarea name="author_note" rows="4">${escapeHtml(work.author_note)}</textarea>
        </label>
        <button class="primary" type="submit">保存</button>
      </form>
    </section>

    <section class="panel">
      <div class="section-heading">
        <h2>共有URL</h2>
        <span class="status">${activeShare ? "有効" : "停止中"}</span>
      </div>
      ${activeShare ? `
        <p>現在のURLプレビュー: <code>${escapeHtml(activeShare.token_preview)}</code></p>
        <div class="actions">
          <form method="post" action="/admin/works/${work.id}/share/revoke">
            <button type="submit">停止</button>
          </form>
          <form method="post" action="/admin/works/${work.id}/share/regenerate">
            <button type="submit">再発行</button>
          </form>
        </div>
      ` : `
        <form method="post" action="/admin/works/${work.id}/share/issue">
          <button class="primary" type="submit">共有URLを発行</button>
        </form>
      `}
      <p class="muted">共有URLは発行直後のみ画面に表示します。忘れた場合は再発行してください。</p>
    </section>

    <section class="two-column">
      <div class="panel">
        <h2>章を追加</h2>
        <form class="stack" method="post" action="/admin/works/${work.id}/chapters">
          <label>章タイトル<input name="title" required></label>
          <label>並び順<input name="sort_order" type="number" value="${chapters.length + 1}"></label>
          <button type="submit">追加</button>
        </form>
      </div>
      <div class="panel">
        <h2>話を追加</h2>
        <form class="stack" method="post" action="/admin/works/${work.id}/stories">
          <label>話タイトル<input name="title" required></label>
          <label>章<select name="chapter_id"><option value="">章なし</option>${chapterOptions}</select></label>
          <label>並び順<input name="sort_order" type="number" value="${stories.length + 1}"></label>
          <button type="submit">追加</button>
        </form>
      </div>
    </section>

    <section class="panel">
      <h2>話</h2>
      <table>
        <thead><tr><th>タイトル</th><th>章</th><th>状態</th><th>版</th><th>順</th></tr></thead>
        <tbody>${storyRows || `<tr><td colspan="5">話がありません。</td></tr>`}</tbody>
      </table>
    </section>

    <section class="panel">
      <div class="section-heading">
        <h2>この作品のコメント</h2>
        <a class="button" href="/admin/comments">全コメント</a>
      </div>
      ${await renderAdminCommentTable(comments, `/admin/works/${work.id}`, {
        emptyMessage: "この作品へのコメントはありません。",
        showWork: false
      })}
    </section>
  `, req, res));
}

async function renderAdminStory(req, res, storyId, url) {
  const story = await getStory(storyId);
  if (!story) return notFound(res);

  const work = await getWork(story.work_id);
  const chapters = await listChapters(story.work_id);
  const versions = await listVersions(story.id);
  const comments = await listCommentsForAdmin({ storyId: story.id });
  const rendered = renderNovelMarkup(story.body_draft || "");
  const published = url.searchParams.get("published");
  const saved = url.searchParams.get("saved");
  const chapterOptions = chapters.map((chapter) => (
    `<option value="${chapter.id}" ${story.chapter_id === chapter.id ? "selected" : ""}>${escapeHtml(chapter.title)}</option>`
  )).join("");
  const statusOptions = Object.entries(STORY_STATUS).map(([value, label]) => (
    `<option value="${value}" ${story.status === value ? "selected" : ""}>${label}</option>`
  )).join("");

  renderHtml(res, 200, adminPage(story.title, `
    <header class="page-header">
      <div>
        <p class="eyebrow">${escapeHtml(work.title)}</p>
        <h1>${escapeHtml(story.title)}</h1>
      </div>
      <a class="button" href="/admin/works/${story.work_id}">作品へ戻る</a>
    </header>

    ${published ? `<section class="notice">ver${escapeHtml(published)} として公開しました。</section>` : ""}
    ${saved ? `<section class="notice">下書きを保存しました。</section>` : ""}

    <section class="editor-layout">
      <form class="panel editor-form" method="post">
        <h2>話の編集</h2>
        <label>タイトル<input name="title" value="${escapeAttr(story.title)}" required></label>
        <label>章<select name="chapter_id"><option value="">章なし</option>${chapterOptions}</select></label>
        <label>並び順<input name="sort_order" type="number" value="${story.sort_order}"></label>
        <label>公開状態<select name="status">${statusOptions}</select></label>
        <section class="txt-import" data-txt-import>
          <h3>txtファイル読み込み</h3>
          <label>ファイル<input type="file" accept=".txt,text/plain" data-txt-file></label>
          <p class="muted" data-txt-info>UTF-8を優先し、読み取れない場合はShift_JISを試します。</p>
          <textarea data-txt-preview rows="6" readonly placeholder="読み込んだ本文のプレビューがここに表示されます。"></textarea>
          <div class="actions">
            <button type="button" data-apply-txt disabled>本文へ反映</button>
            <button type="button" data-clear-txt disabled>クリア</button>
          </div>
        </section>
        <label>本文<textarea name="body" rows="20" required data-story-body-input>${escapeHtml(story.body_draft)}</textarea></label>
        <label>再公開メモ<input name="change_note" placeholder="例: 第三段落を調整"></label>
        <div class="actions">
          <button formaction="/admin/stories/${story.id}/draft" formmethod="post" type="submit">下書き保存</button>
          <button class="primary" formaction="/admin/stories/${story.id}/publish" formmethod="post" type="submit">
            ${story.current_version_number > 0 ? "再公開" : "初回公開"}
          </button>
        </div>
      </form>

        <aside class="panel">
        <div class="section-heading">
          <h2>プレビュー</h2>
          <label class="compact-control">改行間隔
            <input data-preview-gap type="range" min="0" max="20" value="0">
          </label>
        </div>
        <article class="story-preview" data-story-preview>${rendered.html || `<span class="muted">本文がありません。</span>`}</article>
      </aside>
    </section>

    <section class="panel">
      <h2>改稿履歴</h2>
      <table>
        <thead><tr><th>版</th><th>公開日時</th><th>メモ</th></tr></thead>
        <tbody>
          ${versions.map((version) => `
            <tr>
              <td>ver${version.version_number}</td>
              <td>${formatDate(version.published_at)}</td>
              <td>${escapeHtml(version.change_note || "")}</td>
            </tr>
          `).join("") || `<tr><td colspan="3">まだ公開版がありません。</td></tr>`}
        </tbody>
      </table>
    </section>

    <section class="panel">
      <div class="section-heading">
        <h2>この話のコメント</h2>
        <a class="button" href="/admin/comments">全コメント</a>
      </div>
      ${await renderAdminCommentTable(comments, `/admin/stories/${story.id}`, {
        emptyMessage: "この話へのコメントはありません。",
        showWork: false,
        showStory: false
      })}
    </section>
  `, req, res));
}

async function renderAdminComments(req, res) {
  const comments = await listCommentsForAdmin();
  renderHtml(res, 200, adminPage("コメント一覧", `
    <header class="page-header">
      <div>
        <p class="eyebrow">Admin</p>
        <h1>コメント一覧</h1>
      </div>
      <a class="button" href="/admin/works">作品一覧</a>
    </header>
    <section class="panel">
      ${await renderAdminCommentTable(comments, "/admin/comments")}
    </section>
  `, req, res));
}

async function renderAdminCommentTable(
  comments,
  redirectTo,
  {
    emptyMessage = "コメントはありません。",
    showWork = true,
    showStory = true
  } = {}
) {
  const rows = (await Promise.all(comments.map(async (comment) => {
    const replies = await listCommentReplies(comment.id);
    const targetParts = [];
    if (showWork) targetParts.push(escapeHtml(comment.work_title));
    if (showStory) targetParts.push(escapeHtml(comment.story_title));
    const targetLabel = targetParts.length ? targetParts.join(" / ") : `ver${comment.version_number}`;

    return `
      <tr>
        <td>
          <strong>${escapeHtml(comment.reader_name)}</strong>
          <p class="muted">${formatDate(comment.created_at)} / ver${comment.version_number}${comment.edited_at ? " / 編集済み" : ""}</p>
        </td>
        <td>
          <a href="/admin/stories/${comment.story_id}">${targetLabel}</a>
          ${comment.quote_text ? `<blockquote>${escapeHtml(comment.quote_text)}</blockquote>` : ""}
          <div class="comment-body-rendered">${renderCommentBody(comment.body)}</div>
          ${renderCommentReplies(replies, { mode: "admin", redirectTo })}
          <form class="comment-reply-form" method="post" action="/admin/comments/${comment.id}/replies">
            <input type="hidden" name="redirect_to" value="${escapeAttr(redirectTo)}">
            <label>スレッドに返信
              <textarea name="body" rows="3" required maxlength="2000" placeholder="投稿者からの返信を入力"></textarea>
            </label>
            <button type="submit">返信を送信</button>
          </form>
        </td>
        <td>
          <form class="comment-status-form" method="post" action="/admin/comments/${comment.id}/status">
            <input type="hidden" name="redirect_to" value="${escapeAttr(redirectTo)}">
            <select name="status">
              ${Object.entries(COMMENT_STATUS).map(([value, label]) => (
                `<option value="${value}" ${comment.status === value ? "selected" : ""}>${label}</option>`
              )).join("")}
            </select>
            <button type="submit">更新</button>
          </form>
        </td>
      </tr>
    `;
  }))).join("");

  return `
    <table class="comment-table">
      <thead><tr><th>読者</th><th>コメント</th><th>状態</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="3">${escapeHtml(emptyMessage)}</td></tr>`}</tbody>
    </table>
  `;
}

async function renderReaderWork(req, res, token, share) {
  const work = await getWork(share.work_id);
  const stories = await listStoriesForReader(share.work_id);
  renderHtml(res, 200, readerPage(work.title, `
    <div class="reader-shell horizontal" data-reader-shell>
      ${readerSidebar(token, stories)}
      <button class="reader-mobile-overlay" type="button" data-reader-overlay aria-label="話一覧を閉じる"></button>
      <main class="reader-main">
        <section class="work-intro">
          <div class="reader-toolbar reader-work-toolbar">
            <div class="reader-mobile-actions">
              <button class="reader-icon-button" type="button" data-reader-menu-toggle aria-controls="reader-navigation" aria-expanded="false" aria-label="話一覧を開く">
                <span aria-hidden="true">&#9776;</span>
              </button>
            </div>
            <div class="reader-heading">
              <p class="eyebrow">Shared work</p>
              <h1>${escapeHtml(work.title)}</h1>
            </div>
          </div>
          <div class="intro-grid">
            <section>
              <h2>あらすじ</h2>
              <p>${nl2br(work.synopsis || "あらすじは未設定です。")}</p>
            </section>
            <section>
              <h2>作者メモ</h2>
              <p>${nl2br(work.author_note || "作者メモは未設定です。")}</p>
            </section>
          </div>
        </section>
      </main>
    </div>
    <script src="/reader.js" defer></script>
  `, req, res));
}

async function renderReaderStory(req, res, url, token, share, storyId, readerId) {
  const story = await getReadableStory(share.work_id, storyId);
  if (!story) return notFound(res);

  const work = await getWork(share.work_id);
  const stories = await listStoriesForReader(share.work_id);
  const version = await getCurrentVersion(story.id);
  if (!version) return notFound(res);

  const rendered = renderNovelMarkup(version.body);
  const comments = await listReaderComments(story.id, readerId);
  const commentParam = url.searchParams.get("comment") || "";

  renderHtml(res, 200, readerPage(story.title, `
    <div class="reader-shell horizontal" data-reader-shell>
      ${readerSidebar(token, stories, story.id)}
      <button class="reader-mobile-overlay" type="button" data-reader-overlay aria-label="話一覧を閉じる"></button>
      <main class="reader-main">
        <div class="reader-toolbar">
          <div class="reader-mobile-actions">
            <button class="reader-icon-button" type="button" data-reader-menu-toggle aria-controls="reader-navigation" aria-expanded="false" aria-label="話一覧を開く">
              <span aria-hidden="true">&#9776;</span>
            </button>
            <button class="reader-icon-button" type="button" data-reader-settings-toggle aria-controls="reader-controls" aria-expanded="false" aria-label="プレビュー設定を開く">
              <span aria-hidden="true">&#9881;</span>
            </button>
          </div>
          <div class="reader-heading">
            <p class="eyebrow">${escapeHtml(work.title)} / ver${version.version_number}</p>
            <h1>${escapeHtml(story.title)}</h1>
          </div>
          <div class="reader-controls" id="reader-controls" data-reader-controls>
            <label>組み
              <select data-pref="orientation">
                <option value="horizontal">横書き</option>
                <option value="vertical">縦書き</option>
              </select>
            </label>
            <label>文字
              <input data-pref="fontSize" type="range" min="16" max="24" value="18">
            </label>
            <label>行間
              <input data-pref="lineHeight" type="range" min="16" max="24" value="19">
            </label>
            <label>改行
              <input data-pref="paragraphGap" type="range" min="0" max="20" value="0">
            </label>
            <label>配色
              <select data-pref="theme">
                <option value="light">明</option>
                <option value="sepia">紙</option>
                <option value="dark">暗</option>
              </select>
            </label>
          </div>
        </div>

        <div class="story-and-comments">
          <article
            class="story-body"
            data-story-body
            data-plain="${escapeAttr(rendered.plainText)}"
          ><div class="story-body-content">${rendered.html}</div></article>
          <aside class="comment-pane">
            <section class="comment-composer">
              <h2>コメント</h2>
              <form method="post" action="/s/${token}/stories/${story.id}" data-comment-form data-quote-form>
                <label>名前<input name="reader_name" data-reader-name required maxlength="80"></label>
                <input type="hidden" name="quote_text" data-quote-text>
                <input type="hidden" name="quote_start" data-quote-start>
                <input type="hidden" name="quote_end" data-quote-end>
                <input type="hidden" name="quote_context_before" data-quote-context-before>
                <input type="hidden" name="quote_context_after" data-quote-context-after>
                <div class="quote-control">
                  <div class="quote-actions">
                    <button type="button" data-insert-quote disabled>引用</button>
                    <button type="button" data-clear-quote disabled>引用取り消し</button>
                  </div>
                  <div class="quote-preview" data-quote-preview>本文を選択すると引用できます。</div>
                </div>
                <label class="comment-body-field">本文<textarea name="body" rows="5" required maxlength="2000" data-comment-body></textarea></label>
                <button class="primary" type="submit">投稿</button>
              </form>
            </section>
            <section class="comment-list" data-selected-comment="${escapeAttr(commentParam)}">
              <h2>自分のコメント</h2>
              ${(await Promise.all(comments.map((comment) => readerCommentCard(token, comment)))).join("") || `<p class="muted">まだコメントがありません。</p>`}
            </section>
          </aside>
        </div>
      </main>
    </div>
    <script src="/reader.js" defer></script>
  `, req, res));
}

function readerSidebar(token, stories, activeStoryId = null) {
  let lastChapter = Symbol("start");
  const items = stories.map((story) => {
    const chapter = story.chapter_title || "章なし";
    const heading = chapter !== lastChapter ? `<li class="sidebar-heading">${escapeHtml(chapter)}</li>` : "";
    lastChapter = chapter;
    return `
      ${heading}
      <li>
        <a class="${story.id === activeStoryId ? "active" : ""}" href="/s/${token}/stories/${story.id}">
          ${escapeHtml(story.title)}
        </a>
      </li>
    `;
  }).join("");

  return `
    <aside class="reader-sidebar" id="reader-navigation" data-reader-sidebar>
      <div class="reader-sidebar-header">
        <a class="site-title" href="/s/${token}">小説共有</a>
        <button class="reader-sidebar-close" type="button" data-reader-menu-close aria-label="話一覧を閉じる">
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
      <nav><ul>${items || `<li class="muted">公開中の話はありません。</li>`}</ul></nav>
    </aside>
  `;
}

async function readerCommentCard(token, comment) {
  const editFormId = `edit-${comment.id}`;
  const replies = await listCommentReplies(comment.id);
  return `
    <article
      class="comment-card"
      id="comment-${comment.id}"
      data-comment-card="${comment.id}"
      data-quote-start="${comment.quote_start ?? ""}"
      data-quote-end="${comment.quote_end ?? ""}"
    >
      <header>
        <strong>${escapeHtml(comment.reader_name)}</strong>
        <span class="status">${COMMENT_STATUS[comment.status]}</span>
      </header>
      ${comment.quote_text ? `<blockquote>${escapeHtml(comment.quote_text)}</blockquote>` : ""}
      <div class="comment-body-rendered">${renderCommentBody(comment.body)}</div>
      ${renderCommentReplies(replies, { mode: "reader", token, readerId: comment.reader_id })}
      <p class="muted">ver${comment.version_number} / ${formatDate(comment.created_at)}${comment.edited_at ? ` / 編集済み` : ""}</p>
      <details>
        <summary>編集</summary>
        <form id="${editFormId}" method="post" action="/s/${token}/comments/${comment.id}/edit">
          <textarea name="body" rows="4" required maxlength="2000">${escapeHtml(comment.body)}</textarea>
        </form>
        <div class="comment-edit-actions">
          <button form="${editFormId}" type="submit">保存</button>
          <form method="post" action="/s/${token}/comments/${comment.id}/delete" data-confirm="このコメントと返信スレッドを削除します。よろしいですか？">
            <button class="danger" type="submit">削除</button>
          </form>
        </div>
      </details>
      <form class="comment-reply-form reader-reply-form" method="post" action="/s/${token}/comments/${comment.id}/replies" data-quote-form>
        <div class="quote-control reply-quote-control">
          <div class="quote-actions">
            <button type="button" data-insert-quote disabled>引用</button>
            <button type="button" data-clear-quote disabled>引用取り消し</button>
          </div>
          <div class="quote-preview" data-quote-preview>本文を選択すると引用できます。</div>
        </div>
        <label>スレッドに返信
          <textarea name="body" rows="3" required maxlength="2000" placeholder="返信を入力" data-comment-body></textarea>
        </label>
        <button type="submit">返信を送信</button>
      </form>
    </article>
  `;
}

async function getReadableStory(workId, storyId) {
  const story = await getStory(storyId);
  if (!story || story.work_id !== workId || story.status !== "limited" || story.current_version_number < 1) {
    return null;
  }
  return story;
}

function storyForm(form) {
  return {
    title: required(form, "title"),
    chapterId: form.get("chapter_id") || null,
    sortOrder: Number(form.get("sort_order")) || 0,
    status: form.get("status") || "draft",
    body: form.get("body") || ""
  };
}

function renderCommentBody(value) {
  const lines = String(value ?? "").split(/\r?\n/);
  return lines.map((line) => {
    if (line.startsWith(">>")) {
      return `<p class="comment-quote-line">${escapeHtml(line)}</p>`;
    }

    if (!line) {
      return `<p class="comment-empty-line">&nbsp;</p>`;
    }

    return `<p>${escapeHtml(line)}</p>`;
  }).join("");
}

function renderCommentReplies(replies, options = {}) {
  if (!replies.length) return "";

  return `
    <details class="comment-replies">
      <summary>返信スレッド（${replies.length}件）</summary>
      <div class="comment-reply-list">
        ${replies.map((reply) => renderCommentReply(reply, options)).join("")}
      </div>
    </details>
  `;
}

function renderCommentReply(reply, { mode = "reader", token = "", readerId = "", redirectTo = "" } = {}) {
  const role = reply.sender_role === "reader" ? "reader" : "author";
  const roleLabel = role === "author" ? "投稿者" : "読者";
  const senderName = role === "author" ? "投稿者" : (reply.sender_name || "匿名");
  const canEdit = mode === "admin" || (mode === "reader" && role === "reader" && reply.reader_id === readerId);
  const editFormId = `edit-reply-${reply.id}`;
  const actionBase = mode === "admin"
    ? `/admin/comment-replies/${reply.id}`
    : `/s/${token}/comment-replies/${reply.id}`;

  return `
    <article class="comment-reply ${role}">
      <header>
        <strong>${escapeHtml(senderName)}</strong>
        <span>${roleLabel}</span>
      </header>
      <div class="comment-body-rendered">${renderCommentBody(reply.body)}</div>
      <p class="muted">${formatDate(reply.created_at)}${reply.edited_at ? " / 編集済み" : ""}</p>
      ${canEdit ? `
        <details class="comment-reply-editor">
          <summary>編集</summary>
          <form id="${escapeAttr(editFormId)}" class="comment-reply-edit-form" method="post" action="${escapeAttr(`${actionBase}/edit`)}">
            ${mode === "admin" ? `<input type="hidden" name="redirect_to" value="${escapeAttr(redirectTo)}">` : ""}
            <textarea name="body" rows="3" required maxlength="2000">${escapeHtml(reply.body)}</textarea>
          </form>
          <div class="comment-reply-actions">
            <button form="${escapeAttr(editFormId)}" type="submit">保存</button>
            <form method="post" action="${escapeAttr(`${actionBase}/delete`)}" data-confirm="この返信を削除します。よろしいですか？">
              ${mode === "admin" ? `<input type="hidden" name="redirect_to" value="${escapeAttr(redirectTo)}">` : ""}
              <button class="danger" type="submit">削除</button>
            </form>
          </div>
        </details>
      ` : ""}
    </article>
  `;
}

function adminPage(title, body, req, res) {
  return page(title, `
    <div class="app-frame">
      <aside class="admin-nav">
        <a class="site-title" href="/admin/works">小説共有</a>
        <nav>
          <a href="/admin/works">作品</a>
          <a href="/admin/comments">コメント</a>
          <a href="/admin/export">バックアップ</a>
        </nav>
        <form method="post" action="/admin/logout">
          <button type="submit">ログアウト</button>
        </form>
      </aside>
      <main class="app-main">${body}</main>
    </div>
    <script src="/admin.js" defer></script>
  `, "", req, res);
}

function readerPage(title, body, req, res) {
  return page(title, body, "reader-document", req, res);
}

function page(title, body, bodyClass = "", req = null, res = null) {
  const pageBody = req && res ? injectCsrfInputs(body, req, res) : body;
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - 小説共有</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="${bodyClass}">
  ${pageBody}
</body>
</html>`;
}

function injectCsrfInputs(html, req, res) {
  const input = csrfInput(req, res);
  return html.replace(/<form\b([^>]*)>/gi, (match, attributes) => {
    if (!/\bmethod\s*=\s*["']?post["']?/i.test(attributes)) return match;
    return `${match}${input}`;
  });
}

async function serveStatic(pathname, res) {
  const files = {
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/admin.js": ["admin.js", "application/javascript; charset=utf-8"],
    "/reader.js": ["reader.js", "application/javascript; charset=utf-8"],
    "/favicon.svg": ["favicon.svg", "image/svg+xml"],
    "/login-bg.png": ["login-bg.png", "image/png"]
  };
  const file = files[pathname];
  if (!file) return false;

  const content = readFileSync(path.join(publicDir, file[0]));
  res.writeHead(200, securityHeaders({ "Content-Type": file[1] }));
  res.end(content);
  return true;
}

function renderHtml(res, status, html) {
  res.writeHead(status, securityHeaders({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  }));
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(303, securityHeaders({ Location: location }));
  res.end();
}

function securityHeaders(headers = {}) {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self'"
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    ...headers
  };
}

function safeAdminRedirect(value) {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/admin")) return null;
  if (value.startsWith("//")) return null;
  return value;
}

function assertRuntimeConfig() {
  if (!IS_PRODUCTION) return;

  const errors = [];
  if (!process.env.ADMIN_PASSWORD || ADMIN_PASSWORD === "novel-admin") {
    errors.push("ADMIN_PASSWORD must be set to a non-default value in production.");
  }
  if (!process.env.APP_SECRET || APP_SECRET === "dev-secret-change-me" || APP_SECRET.length < 32) {
    errors.push("APP_SECRET must be set to at least 32 characters in production.");
  }

  if (errors.length) {
    throw new Error(errors.join(" "));
  }
}

function publicUrl(pathname) {
  return PUBLIC_ORIGIN ? `${PUBLIC_ORIGIN}${pathname}` : pathname;
}

function normalizePublicOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const origin = new URL(raw).origin;
    if (!/^https?:\/\//.test(origin)) return "";
    return origin;
  } catch {
    return "";
  }
}

function normalizeShareToken(value) {
  if (typeof value !== "string") return "";
  return /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : "";
}

function notFound(res) {
  renderHtml(res, 404, page("見つかりません", `
    <section class="panel narrow">
      <h1>見つかりません</h1>
      <p>指定されたページは存在しないか、閲覧できません。</p>
    </section>
  `));
}

function forbidden(res, message = "この操作は許可されていません。") {
  renderHtml(res, 403, page("操作できません", `
    <section class="panel narrow">
      <h1>操作できません</h1>
      <p>${escapeHtml(message)}</p>
    </section>
  `));
}

function required(form, name) {
  const value = String(form.get(name) || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readForm(req) {
  if (req.formData) return Promise.resolve(req.formData);

  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("form is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      req.formData = new URLSearchParams(body);
      resolve(req.formData);
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const cookies = {};
  for (const pair of raw.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function cookieHeader(req, name, value, {
  path = "/",
  maxAge = null,
  httpOnly = true,
  sameSite = "Lax"
} = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (maxAge !== null) parts.push(`Max-Age=${maxAge}`);
  if (httpOnly) parts.push("HttpOnly");
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (shouldUseSecureCookies(req)) parts.push("Secure");
  return parts.join("; ");
}

function shouldUseSecureCookies(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return forwardedProto === "https"
    || Boolean(req.socket.encrypted)
    || (IS_PRODUCTION && PUBLIC_ORIGIN.startsWith("https://"));
}

function addCookie(res, cookie) {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", cookie);
    return;
  }
  if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current, cookie]);
    return;
  }
  res.setHeader("Set-Cookie", [current, cookie]);
}

function csrfInput(req, res) {
  return `<input type="hidden" name="csrf_token" value="${escapeAttr(getCsrfToken(req, res))}">`;
}

function getCsrfToken(req, res) {
  const seed = ensureCsrfSeed(req, res);
  return sign(`csrf.${seed}`);
}

function ensureCsrfSeed(req, res) {
  const cookies = parseCookies(req);
  if (isValidCsrfSeed(cookies[CSRF_COOKIE_NAME])) {
    return cookies[CSRF_COOKIE_NAME];
  }

  const seed = randomBytes(32).toString("base64url");
  addCookie(res, cookieHeader(req, CSRF_COOKIE_NAME, seed, {
    maxAge: CSRF_MAX_AGE,
    httpOnly: true
  }));
  return seed;
}

function verifyCsrf(req, form) {
  const seed = parseCookies(req)[CSRF_COOKIE_NAME];
  if (!isValidCsrfSeed(seed)) return false;

  const submitted = String(form.get("csrf_token") || "");
  if (!submitted) return false;
  return safeEqual(submitted, sign(`csrf.${seed}`));
}

function isValidCsrfSeed(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function makeAdminSession() {
  return signedValue("admin-session", `admin.${Date.now()}`);
}

function isAdmin(req) {
  const session = parseCookies(req).admin_session;
  if (!session) return false;

  const value = verifySignedValue("admin-session", session);
  if (!value) return false;

  const parts = value.split(".");
  if (parts.length !== 2 || parts[0] !== "admin") return false;

  const issuedAt = Number(parts[1]);
  if (!Number.isFinite(issuedAt)) return false;

  const age = Date.now() - issuedAt;
  return age >= 0 && age <= ADMIN_SESSION_MAX_AGE * 1000;
}

function sign(value) {
  return createHmac("sha256", APP_SECRET).update(value).digest("base64url");
}

function signedValue(purpose, value) {
  return `${value}.${sign(`${purpose}.${value}`)}`;
}

function verifySignedValue(purpose, value) {
  if (typeof value !== "string") return "";

  const parts = value.split(".");
  if (parts.length < 2) return "";

  const signature = parts.pop();
  const payload = parts.join(".");
  const expected = sign(`${purpose}.${payload}`);
  return safeEqual(signature, expected) ? payload : "";
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function ensureReaderId(req, res) {
  const cookies = parseCookies(req);
  const readerId = verifySignedValue("reader-id", cookies.reader_id);
  if (isValidReaderId(readerId)) return readerId;

  const nextReaderId = makeId("reader");
  addCookie(res, cookieHeader(req, "reader_id", signedValue("reader-id", nextReaderId), {
    maxAge: READER_COOKIE_MAX_AGE,
    httpOnly: true
  }));
  return nextReaderId;
}

function isValidReaderId(value) {
  return typeof value === "string" && /^reader_[a-f0-9]{18}$/.test(value);
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("\n", "&#10;");
}

function nl2br(value) {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
