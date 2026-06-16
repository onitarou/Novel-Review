import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";

const dataDir = path.join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });

const databaseUrl = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || `file:${path.join(dataDir, "app.sqlite")}`;
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

export const db = createClient({
  url: databaseUrl,
  ...(authToken ? { authToken } : {})
});

export const STORY_STATUS = {
  draft: "下書き",
  limited: "限定公開",
  private: "非公開"
};

export const COMMENT_STATUS = {
  unread: "未読",
  seen: "確認済み",
  resolved: "対応済み",
  deferred: "保留"
};

export async function initDb() {
  await run("PRAGMA foreign_keys = ON");
  await execMany(`
    CREATE TABLE IF NOT EXISTS works (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      synopsis TEXT NOT NULL DEFAULT '',
      author_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES works(id),
      title TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES works(id),
      chapter_id TEXT REFERENCES chapters(id),
      title TEXT NOT NULL,
      body_draft TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      current_version_number INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      CHECK (status IN ('draft', 'limited', 'private'))
    );

    CREATE TABLE IF NOT EXISTS story_versions (
      id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL REFERENCES stories(id),
      version_number INTEGER NOT NULL,
      body TEXT NOT NULL,
      change_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      published_at TEXT NOT NULL,
      UNIQUE (story_id, version_number)
    );

    CREATE TABLE IF NOT EXISTS share_links (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES works(id),
      token_hash TEXT NOT NULL UNIQUE,
      token_preview TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      issued_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_reason TEXT,
      CHECK (status IN ('active', 'revoked'))
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES works(id),
      story_id TEXT NOT NULL REFERENCES stories(id),
      story_version_id TEXT NOT NULL REFERENCES story_versions(id),
      reader_id TEXT NOT NULL,
      reader_name TEXT NOT NULL,
      body TEXT NOT NULL,
      quote_text TEXT NOT NULL DEFAULT '',
      quote_start INTEGER,
      quote_end INTEGER,
      quote_context_before TEXT NOT NULL DEFAULT '',
      quote_context_after TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'unread',
      created_at TEXT NOT NULL,
      edited_at TEXT,
      deleted_at TEXT,
      CHECK (status IN ('unread', 'seen', 'resolved', 'deferred'))
    );

    CREATE TABLE IF NOT EXISTS comment_replies (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL REFERENCES comments(id),
      sender_role TEXT NOT NULL DEFAULT 'author',
      sender_name TEXT NOT NULL DEFAULT '投稿者',
      reader_id TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT,
      deleted_at TEXT,
      CHECK (sender_role IN ('author', 'reader'))
    );

    CREATE TABLE IF NOT EXISTS story_ratings (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES works(id),
      story_id TEXT NOT NULL REFERENCES stories(id),
      story_version_id TEXT NOT NULL REFERENCES story_versions(id),
      reader_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (story_id, reader_id),
      CHECK (score IN (1, 2, 3))
    );

    CREATE TABLE IF NOT EXISTS survey_questions (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES works(id),
      prompt TEXT NOT NULL,
      answer_type TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      CHECK (answer_type IN ('rating_5', 'text', 'number'))
    );

    CREATE TABLE IF NOT EXISTS survey_responses (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES works(id),
      reader_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (work_id, reader_id)
    );

    CREATE TABLE IF NOT EXISTS survey_answers (
      id TEXT PRIMARY KEY,
      response_id TEXT NOT NULL REFERENCES survey_responses(id),
      question_id TEXT NOT NULL REFERENCES survey_questions(id),
      value_text TEXT,
      value_number REAL,
      value_rating INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (response_id, question_id),
      CHECK (value_rating IS NULL OR value_rating IN (1, 2, 3, 4, 5))
    );

    CREATE INDEX IF NOT EXISTS idx_chapters_work ON chapters(work_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_stories_work ON stories(work_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_versions_story ON story_versions(story_id, version_number);
    CREATE INDEX IF NOT EXISTS idx_comments_story ON comments(story_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_comment_replies_comment ON comment_replies(comment_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_story_ratings_story ON story_ratings(story_id, score);
    CREATE INDEX IF NOT EXISTS idx_story_ratings_work ON story_ratings(work_id, story_id);
    CREATE INDEX IF NOT EXISTS idx_survey_questions_work ON survey_questions(work_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_survey_responses_work ON survey_responses(work_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_survey_answers_response ON survey_answers(response_id, question_id);
    CREATE INDEX IF NOT EXISTS idx_share_links_work ON share_links(work_id, status);
  `);

  await migrateCommentReplies();
  await seedIfEmpty();
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

export function makeToken() {
  return randomBytes(24).toString("base64url");
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("base64url");
}

async function all(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows.map((row) => ({ ...row }));
}

async function get(sql, args = []) {
  const rows = await all(sql, args);
  return rows[0];
}

async function run(sql, args = []) {
  await db.execute({ sql, args });
}

async function execMany(sql) {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await run(statement);
  }
}

export async function listWorks() {
  return all(`
    SELECT
      works.*,
      (
        SELECT COUNT(*)
        FROM comments
        WHERE comments.work_id = works.id
          AND comments.deleted_at IS NULL
          AND comments.status = 'unread'
      ) AS unread_count,
      (
        SELECT COUNT(*)
        FROM share_links
        WHERE share_links.work_id = works.id
          AND share_links.status = 'active'
      ) AS active_share_count
    FROM works
    WHERE works.deleted_at IS NULL
    ORDER BY works.updated_at DESC
  `);
}

export async function createWork({ title, synopsis = "", authorNote = "" }) {
  const id = makeId("work");
  const now = nowIso();
  await run(`
    INSERT INTO works (id, title, synopsis, author_note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, title, synopsis, authorNote, now, now]);
  return id;
}

export async function getWork(workId) {
  return get(`
    SELECT * FROM works WHERE id = ? AND deleted_at IS NULL
  `, [workId]);
}

export async function updateWork(workId, { title, synopsis, authorNote }) {
  await run(`
    UPDATE works
    SET title = ?, synopsis = ?, author_note = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `, [title, synopsis, authorNote, nowIso(), workId]);
}

export async function listChapters(workId) {
  return all(`
    SELECT * FROM chapters
    WHERE work_id = ? AND deleted_at IS NULL
    ORDER BY sort_order, created_at
  `, [workId]);
}

export async function createChapter(workId, { title, sortOrder = 0 }) {
  const id = makeId("chapter");
  const now = nowIso();
  await run(`
    INSERT INTO chapters (id, work_id, title, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, workId, title, sortOrder, now, now]);
  await touchWork(workId);
  return id;
}

export async function listStoriesForAdmin(workId) {
  return all(`
    SELECT
      stories.*,
      chapters.title AS chapter_title,
      (
        SELECT COUNT(*)
        FROM story_ratings
        WHERE story_ratings.story_id = stories.id
      ) AS rating_count,
      (
        SELECT ROUND(AVG(score), 2)
        FROM story_ratings
        WHERE story_ratings.story_id = stories.id
      ) AS rating_average
    FROM stories
    LEFT JOIN chapters ON chapters.id = stories.chapter_id
    WHERE stories.work_id = ? AND stories.deleted_at IS NULL
    ORDER BY COALESCE(chapters.sort_order, -1), stories.sort_order, stories.created_at
  `, [workId]);
}

export async function listStoriesForReader(workId) {
  return all(`
    SELECT stories.*, chapters.title AS chapter_title, chapters.sort_order AS chapter_sort_order
    FROM stories
    LEFT JOIN chapters ON chapters.id = stories.chapter_id
    WHERE stories.work_id = ?
      AND stories.deleted_at IS NULL
      AND stories.status = 'limited'
      AND stories.current_version_number > 0
    ORDER BY COALESCE(chapters.sort_order, -1), stories.sort_order, stories.created_at
  `, [workId]);
}

export async function createStory(workId, { title, chapterId = null, sortOrder = 0 }) {
  const id = makeId("story");
  const now = nowIso();
  await run(`
    INSERT INTO stories (id, work_id, chapter_id, title, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, workId, emptyToNull(chapterId), title, sortOrder, now, now]);
  await touchWork(workId);
  return id;
}

export async function getStory(storyId) {
  return get(`
    SELECT stories.*, works.title AS work_title
    FROM stories
    JOIN works ON works.id = stories.work_id
    WHERE stories.id = ? AND stories.deleted_at IS NULL AND works.deleted_at IS NULL
  `, [storyId]);
}

export async function updateStoryDraft(storyId, { title, chapterId, sortOrder, status, body }) {
  const story = await getStory(storyId);
  if (!story) return;

  await run(`
    UPDATE stories
    SET title = ?, chapter_id = ?, sort_order = ?, status = ?, body_draft = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `, [title, emptyToNull(chapterId), Number(sortOrder) || 0, status, body, nowIso(), storyId]);

  await touchWork(story.work_id);
}

export async function publishStory(storyId, { title, chapterId, sortOrder, body, changeNote }) {
  const story = await getStory(storyId);
  if (!story) return null;

  const nextVersion = Number(story.current_version_number) + 1 || 1;
  const versionId = makeId("version");
  const now = nowIso();

  await run(`
    INSERT INTO story_versions
      (id, story_id, version_number, body, change_note, created_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [versionId, storyId, nextVersion, body, changeNote ?? "", now, now]);

  await run(`
    UPDATE stories
    SET title = ?,
        chapter_id = ?,
        sort_order = ?,
        body_draft = ?,
        status = 'limited',
        current_version_number = ?,
        updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `, [title, emptyToNull(chapterId), Number(sortOrder) || 0, body, nextVersion, now, storyId]);

  await touchWork(story.work_id);
  return { versionId, versionNumber: nextVersion };
}

export async function listVersions(storyId) {
  return all(`
    SELECT * FROM story_versions
    WHERE story_id = ?
    ORDER BY version_number DESC
  `, [storyId]);
}

export async function getCurrentVersion(storyId) {
  return get(`
    SELECT story_versions.*
    FROM story_versions
    JOIN stories ON stories.id = story_versions.story_id
    WHERE story_versions.story_id = ?
      AND story_versions.version_number = stories.current_version_number
  `, [storyId]);
}

export async function getVersionById(versionId) {
  return get("SELECT * FROM story_versions WHERE id = ?", [versionId]);
}

export async function getActiveShareLink(workId) {
  return get(`
    SELECT * FROM share_links
    WHERE work_id = ? AND status = 'active'
    ORDER BY issued_at DESC
    LIMIT 1
  `, [workId]);
}

export async function issueShareLink(workId) {
  const active = await getActiveShareLink(workId);
  if (active) return { token: null, active };

  const token = makeToken();
  const id = makeId("share");
  const now = nowIso();
  await run(`
    INSERT INTO share_links
      (id, work_id, token_hash, token_preview, status, issued_at)
    VALUES (?, ?, ?, ?, 'active', ?)
  `, [id, workId, hashToken(token), previewToken(token), now]);
  await touchWork(workId);
  return { token, active: await getActiveShareLink(workId) };
}

export async function revokeShareLink(workId, reason = "manual") {
  const now = nowIso();
  await run(`
    UPDATE share_links
    SET status = 'revoked', revoked_at = ?, revoked_reason = ?
    WHERE work_id = ? AND status = 'active'
  `, [now, reason, workId]);
  await touchWork(workId);
}

export async function regenerateShareLink(workId) {
  await revokeShareLink(workId, "regenerated");
  return issueShareLink(workId);
}

export async function getShareByToken(token) {
  return get(`
    SELECT share_links.*, works.title AS work_title
    FROM share_links
    JOIN works ON works.id = share_links.work_id
    WHERE share_links.token_hash = ?
      AND share_links.status = 'active'
      AND works.deleted_at IS NULL
    LIMIT 1
  `, [hashToken(token)]);
}

export async function createComment({
  workId,
  storyId,
  storyVersionId,
  readerId,
  readerName,
  body,
  quoteText = "",
  quoteStart = null,
  quoteEnd = null,
  quoteContextBefore = "",
  quoteContextAfter = ""
}) {
  const id = makeId("comment");
  const now = nowIso();
  await run(`
    INSERT INTO comments (
      id,
      work_id,
      story_id,
      story_version_id,
      reader_id,
      reader_name,
      body,
      quote_text,
      quote_start,
      quote_end,
      quote_context_before,
      quote_context_after,
      status,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?)
  `, [
    id,
    workId,
    storyId,
    storyVersionId,
    readerId,
    readerName,
    body,
    quoteText,
    nullableNumber(quoteStart),
    nullableNumber(quoteEnd),
    quoteContextBefore,
    quoteContextAfter,
    now
  ]);
  return id;
}

export async function listReaderComments(storyId, readerId) {
  return all(`
    SELECT comments.*, story_versions.version_number
    FROM comments
    JOIN story_versions ON story_versions.id = comments.story_version_id
    WHERE comments.story_id = ?
      AND comments.reader_id = ?
      AND comments.deleted_at IS NULL
    ORDER BY comments.created_at DESC
  `, [storyId, readerId]);
}

export async function listCommentsForAdmin({ workId = null, storyId = null } = {}) {
  const conditions = [
    "comments.deleted_at IS NULL",
    "works.deleted_at IS NULL",
    "stories.deleted_at IS NULL"
  ];
  const params = [];

  if (workId) {
    conditions.push("comments.work_id = ?");
    params.push(workId);
  }

  if (storyId) {
    conditions.push("comments.story_id = ?");
    params.push(storyId);
  }

  return all(`
    SELECT
      comments.*,
      works.title AS work_title,
      stories.title AS story_title,
      story_versions.version_number
    FROM comments
    JOIN works ON works.id = comments.work_id
    JOIN stories ON stories.id = comments.story_id
    JOIN story_versions ON story_versions.id = comments.story_version_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY comments.created_at DESC
  `, params);
}

export async function getComment(commentId) {
  return get(`
    SELECT comments.*, stories.title AS story_title
    FROM comments
    JOIN stories ON stories.id = comments.story_id
    WHERE comments.id = ?
  `, [commentId]);
}

export async function createCommentReply(
  commentId,
  {
    senderRole = "author",
    senderName = "投稿者",
    readerId = null,
    body
  }
) {
  const id = makeId("reply");
  const now = nowIso();
  const normalizedRole = senderRole === "reader" ? "reader" : "author";
  const fallbackName = normalizedRole === "author" ? "投稿者" : "匿名";
  const normalizedName = String(senderName || fallbackName).trim() || fallbackName;

  await run(`
    INSERT INTO comment_replies (id, comment_id, sender_role, sender_name, reader_id, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, commentId, normalizedRole, normalizedName, readerId, body, now]);

  if (normalizedRole === "reader") {
    await run(`
      UPDATE comments
      SET status = 'unread'
      WHERE id = ? AND deleted_at IS NULL
    `, [commentId]);
  }

  return id;
}

export async function listCommentReplies(commentId) {
  return all(`
    SELECT *
    FROM comment_replies
    WHERE comment_id = ? AND deleted_at IS NULL
    ORDER BY created_at ASC
  `, [commentId]);
}

export async function getCommentReply(replyId) {
  return get(`
    SELECT
      comment_replies.*,
      comments.work_id,
      comments.story_id,
      comments.reader_id AS comment_reader_id,
      comments.deleted_at AS comment_deleted_at
    FROM comment_replies
    JOIN comments ON comments.id = comment_replies.comment_id
    WHERE comment_replies.id = ?
  `, [replyId]);
}

export async function updateCommentReply(replyId, body) {
  await run(`
    UPDATE comment_replies
    SET body = ?, edited_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `, [body, nowIso(), replyId]);
}

export async function updateCommentReplyByReader(replyId, readerId, body) {
  await run(`
    UPDATE comment_replies
    SET body = ?, edited_at = ?
    WHERE id = ?
      AND sender_role = 'reader'
      AND reader_id = ?
      AND deleted_at IS NULL
  `, [body, nowIso(), replyId, readerId]);

  await markReplyCommentUnread(replyId);
}

export async function deleteCommentReply(replyId) {
  await run(`
    UPDATE comment_replies
    SET body = '', deleted_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `, [nowIso(), replyId]);
}

export async function deleteCommentReplyByReader(replyId, readerId) {
  await run(`
    UPDATE comment_replies
    SET body = '', deleted_at = ?
    WHERE id = ?
      AND sender_role = 'reader'
      AND reader_id = ?
      AND deleted_at IS NULL
  `, [nowIso(), replyId, readerId]);

  await markReplyCommentUnread(replyId);
}

export async function updateCommentByReader(commentId, readerId, body) {
  await run(`
    UPDATE comments
    SET body = ?, edited_at = ?, status = 'unread'
    WHERE id = ? AND reader_id = ? AND deleted_at IS NULL
  `, [body, nowIso(), commentId, readerId]);
}

export async function deleteCommentByReader(commentId, readerId) {
  await run(`
    UPDATE comments
    SET body = '', quote_text = '', deleted_at = ?
    WHERE id = ? AND reader_id = ? AND deleted_at IS NULL
  `, [nowIso(), commentId, readerId]);
}

export async function updateCommentStatus(commentId, status) {
  if (!Object.hasOwn(COMMENT_STATUS, status)) return;
  await run(`
    UPDATE comments
    SET status = ?
    WHERE id = ? AND deleted_at IS NULL
  `, [status, commentId]);
}

export async function upsertStoryRating({
  workId,
  storyId,
  storyVersionId,
  readerId,
  score
}) {
  const normalizedScore = Number(score);
  if (![1, 2, 3].includes(normalizedScore)) {
    throw new Error("rating score must be 1, 2, or 3");
  }

  const now = nowIso();
  const existing = await get(`
    SELECT id
    FROM story_ratings
    WHERE story_id = ? AND reader_id = ?
  `, [storyId, readerId]);

  if (existing) {
    await run(`
      UPDATE story_ratings
      SET work_id = ?,
          story_version_id = ?,
          score = ?,
          updated_at = ?
      WHERE id = ?
    `, [workId, storyVersionId, normalizedScore, now, existing.id]);
    return existing.id;
  }

  const id = makeId("rating");
  await run(`
    INSERT INTO story_ratings (
      id,
      work_id,
      story_id,
      story_version_id,
      reader_id,
      score,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, workId, storyId, storyVersionId, readerId, normalizedScore, now, now]);
  return id;
}

export async function getReaderStoryRating(storyId, readerId) {
  return get(`
    SELECT *
    FROM story_ratings
    WHERE story_id = ? AND reader_id = ?
  `, [storyId, readerId]);
}

export async function getStoryRatingSummary(storyId) {
  const summary = await get(`
    SELECT
      COUNT(*) AS rating_count,
      ROUND(AVG(score), 2) AS rating_average,
      SUM(CASE WHEN score = 1 THEN 1 ELSE 0 END) AS score_1_count,
      SUM(CASE WHEN score = 2 THEN 1 ELSE 0 END) AS score_2_count,
      SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END) AS score_3_count
    FROM story_ratings
    WHERE story_id = ?
  `, [storyId]);

  return {
    rating_count: Number(summary?.rating_count || 0),
    rating_average: summary?.rating_average === null || summary?.rating_average === undefined
      ? null
      : Number(summary.rating_average),
    score_1_count: Number(summary?.score_1_count || 0),
    score_2_count: Number(summary?.score_2_count || 0),
    score_3_count: Number(summary?.score_3_count || 0)
  };
}

export async function listSurveyQuestions(workId) {
  return all(`
    SELECT *
    FROM survey_questions
    WHERE work_id = ? AND deleted_at IS NULL
    ORDER BY sort_order, created_at
  `, [workId]);
}

export async function createSurveyQuestion(workId, { prompt, answerType, sortOrder = 0 }) {
  if (!isSurveyAnswerType(answerType)) {
    throw new Error("invalid survey question type");
  }

  const id = makeId("surveyq");
  const now = nowIso();
  await run(`
    INSERT INTO survey_questions (
      id,
      work_id,
      prompt,
      answer_type,
      sort_order,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, workId, prompt, answerType, Number(sortOrder) || 0, now, now]);
  await touchWork(workId);
  return id;
}

export async function deleteSurveyQuestion(questionId) {
  const question = await get(`
    SELECT *
    FROM survey_questions
    WHERE id = ? AND deleted_at IS NULL
  `, [questionId]);
  if (!question) return null;

  const now = nowIso();
  await run(`
    UPDATE survey_questions
    SET deleted_at = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `, [now, now, questionId]);
  await touchWork(question.work_id);
  return question;
}

export async function getReaderSurveyAnswers(workId, readerId) {
  const response = await get(`
    SELECT *
    FROM survey_responses
    WHERE work_id = ? AND reader_id = ?
  `, [workId, readerId]);
  if (!response) return { response: null, answers: [] };

  const answers = await all(`
    SELECT survey_answers.*
    FROM survey_answers
    JOIN survey_questions ON survey_questions.id = survey_answers.question_id
    WHERE survey_answers.response_id = ?
      AND survey_questions.deleted_at IS NULL
    ORDER BY survey_questions.sort_order, survey_questions.created_at
  `, [response.id]);

  return { response, answers };
}

export async function saveSurveyResponse({ workId, readerId, questionIds, answers }) {
  const now = nowIso();
  let response = await get(`
    SELECT *
    FROM survey_responses
    WHERE work_id = ? AND reader_id = ?
  `, [workId, readerId]);

  if (response) {
    await run(`
      UPDATE survey_responses
      SET updated_at = ?
      WHERE id = ?
    `, [now, response.id]);
  } else {
    const id = makeId("surveyres");
    await run(`
      INSERT INTO survey_responses (id, work_id, reader_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `, [id, workId, readerId, now, now]);
    response = { id, work_id: workId, reader_id: readerId };
  }

  const answeredQuestionIds = new Set(answers.map((answer) => answer.questionId));
  for (const questionId of questionIds) {
    if (answeredQuestionIds.has(questionId)) continue;
    await run(`
      DELETE FROM survey_answers
      WHERE response_id = ? AND question_id = ?
    `, [response.id, questionId]);
  }

  for (const answer of answers) {
    await upsertSurveyAnswer(response.id, answer, now);
  }

  return response.id;
}

export async function listSurveyResponses(workId) {
  return all(`
    SELECT *
    FROM survey_responses
    WHERE work_id = ?
    ORDER BY updated_at DESC
  `, [workId]);
}

export async function listSurveyAnswersForResponse(responseId) {
  return all(`
    SELECT
      survey_answers.*,
      survey_questions.prompt,
      survey_questions.answer_type,
      survey_questions.sort_order,
      survey_questions.deleted_at AS question_deleted_at
    FROM survey_answers
    JOIN survey_questions ON survey_questions.id = survey_answers.question_id
    WHERE survey_answers.response_id = ?
    ORDER BY survey_questions.sort_order, survey_questions.created_at
  `, [responseId]);
}

export async function exportSnapshot() {
  return {
    exportedAt: nowIso(),
    works: await all("SELECT * FROM works"),
    chapters: await all("SELECT * FROM chapters"),
    stories: await all("SELECT * FROM stories"),
    storyVersions: await all("SELECT * FROM story_versions"),
    shareLinks: await all(`
      SELECT id, work_id, token_preview, status, issued_at, revoked_at, revoked_reason
      FROM share_links
    `),
    comments: await all("SELECT * FROM comments"),
    commentReplies: await all("SELECT * FROM comment_replies"),
    storyRatings: await all("SELECT * FROM story_ratings"),
    surveyQuestions: await all("SELECT * FROM survey_questions"),
    surveyResponses: await all("SELECT * FROM survey_responses"),
    surveyAnswers: await all("SELECT * FROM survey_answers")
  };
}

async function touchWork(workId) {
  await run(`
    UPDATE works SET updated_at = ? WHERE id = ? AND deleted_at IS NULL
  `, [nowIso(), workId]);
}

function emptyToNull(value) {
  return value === "" || value === undefined ? null : value;
}

function nullableNumber(value) {
  if (value === "" || value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isSurveyAnswerType(value) {
  return ["rating_5", "text", "number"].includes(value);
}

async function upsertSurveyAnswer(responseId, answer, now) {
  const existing = await get(`
    SELECT id
    FROM survey_answers
    WHERE response_id = ? AND question_id = ?
  `, [responseId, answer.questionId]);

  const valueText = answer.valueText ?? null;
  const valueNumber = nullableNumber(answer.valueNumber);
  const valueRating = nullableNumber(answer.valueRating);

  if (existing) {
    await run(`
      UPDATE survey_answers
      SET value_text = ?,
          value_number = ?,
          value_rating = ?,
          updated_at = ?
      WHERE id = ?
    `, [valueText, valueNumber, valueRating, now, existing.id]);
    return existing.id;
  }

  const id = makeId("surveya");
  await run(`
    INSERT INTO survey_answers (
      id,
      response_id,
      question_id,
      value_text,
      value_number,
      value_rating,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, responseId, answer.questionId, valueText, valueNumber, valueRating, now, now]);
  return id;
}

async function migrateCommentReplies() {
  const columns = (await all("PRAGMA table_info(comment_replies)")).map((column) => column.name);
  await addColumnIfMissing(columns, "sender_role", "ALTER TABLE comment_replies ADD COLUMN sender_role TEXT NOT NULL DEFAULT 'author'");
  await addColumnIfMissing(columns, "sender_name", "ALTER TABLE comment_replies ADD COLUMN sender_name TEXT NOT NULL DEFAULT '投稿者'");
  await addColumnIfMissing(columns, "reader_id", "ALTER TABLE comment_replies ADD COLUMN reader_id TEXT");
  await addColumnIfMissing(columns, "edited_at", "ALTER TABLE comment_replies ADD COLUMN edited_at TEXT");
}

async function addColumnIfMissing(columns, columnName, sql) {
  if (columns.includes(columnName)) return;
  await run(sql);
  columns.push(columnName);
}

async function markReplyCommentUnread(replyId) {
  await run(`
    UPDATE comments
    SET status = 'unread'
    WHERE id = (
      SELECT comment_id
      FROM comment_replies
      WHERE id = ?
    )
    AND deleted_at IS NULL
  `, [replyId]);
}

function previewToken(token) {
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}

async function seedIfEmpty() {
  const { count } = await get("SELECT COUNT(*) AS count FROM works");
  if (count > 0) return;

  const now = nowIso();
  const workId = "work_sample";
  const chapterId = "chapter_sample_1";
  const storyId = "story_sample_1";
  const versionId = "version_sample_1";
  const shareId = "share_sample_1";
  const sampleToken = "sample-share";
  const body = [
    "雨上がりの路地には、まだ夜の{匂い}{におい}が残っていた。",
    "",
    "水たまりを覗きこむと、そこには空ではなく、誰かが置き忘れたような{確かな予感}{・}が揺れている。",
    "",
    "私はその小さな震えを見なかったことにして、鞄の中の原稿を抱え直した。"
  ].join("\n");

  await run(`
    INSERT INTO works (id, title, synopsis, author_note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    workId,
    "雨上がりの読書会",
    "限定共有と引用コメントの動作を確認するためのサンプル作品です。",
    "特に冒頭の雰囲気と一文の長さについて批評してもらう想定です。",
    now,
    now
  ]);

  await run(`
    INSERT INTO chapters (id, work_id, title, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `, [chapterId, workId, "第一章", now, now]);

  await run(`
    INSERT INTO stories (
      id, work_id, chapter_id, title, body_draft, status, sort_order,
      current_version_number, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'limited', 1, 1, ?, ?)
  `, [storyId, workId, chapterId, "第一話 路地の水たまり", body, now, now]);

  await run(`
    INSERT INTO story_versions
      (id, story_id, version_number, body, change_note, created_at, published_at)
    VALUES (?, ?, 1, ?, ?, ?, ?)
  `, [versionId, storyId, body, "初回公開", now, now]);

  await run(`
    INSERT INTO share_links
      (id, work_id, token_hash, token_preview, status, issued_at)
    VALUES (?, ?, ?, ?, 'active', ?)
  `, [shareId, workId, hashToken(sampleToken), previewToken(sampleToken), now]);
}
