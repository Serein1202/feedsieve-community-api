// ==UserScript==
// @name         FeedSieve
// @name:zh-CN   FeedSieve 垃圾账号清理
// @namespace    https://github.com/realchendahuang/feedsieve
// @version      0.1.0
// @description  Visible first, block only. Mark spam accounts with a yellow box on x.com and block them through the page's own native endpoint. Never hides content. Local detect. Community list.
// @description:zh-CN  可见优先，拉黑唯一。在 x.com 用黄框标注垃圾账号，经页面自身原生接口拉黑，永不隐藏内容。
// @author       FeedSieve contributors
// @license      MIT
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
//   ↑ 同步名单/词库需要打自定义 API；默认 https://feedsieve-api.chendahuang.com，留空=用默认。
// @run-at       document-start
// @noframes
// ==/UserScript==

"use strict";
(() => {
  // ../../packages/detector/src/heuristics.ts
  var DEFAULT_NAME_RE = /^(?:user|用户)[\s\u00a0]*\d{5,}$/i;
  var DIGIT_TAIL_HANDLE_RE = /^[a-z]{1,10}\d{5,}$/;
  var defaultNameDigits = {
    id: "default-name-digits",
    check(input) {
      const displayName = input.displayName?.trim();
      if (displayName && DEFAULT_NAME_RE.test(displayName)) {
        return "默认名 + 随机数字，疑似批量注册账号";
      }
      if (DIGIT_TAIL_HANDLE_RE.test(input.handle) && displayName && DEFAULT_NAME_RE.test(displayName)) {
        return "handle 为短前缀长数字，且昵称也是默认数字名";
      }
      return null;
    }
  };
  var SPAM_HOST_HINT_RE = /(?:giveaway|airdrop|freecrypto|freegift|claimrewards?)/i;
  var spamLinkHint = {
    id: "spam-link-hint",
    check(input) {
      for (const link of input.links ?? []) {
        if (!link.hostname) {
          continue;
        }
        if (SPAM_HOST_HINT_RE.test(link.hostname)) {
          return `链接指向可疑推广域名（${link.hostname}）`;
        }
      }
      return null;
    }
  };
  var TEMPLATED_PATTERNS = [
    [
      /(?:加|私)(?:我)?(?:微信|QQ|扣扣)|带单(?:老师)?|内部(?:群|渠道)|包赚|稳赚不赔/i,
      "中文引流 / 带单话术"
    ],
    [
      /\b(?:dm|pm)\s+(?:me|us)\b[\s\S]{0,40}\b(?:invest|crypto|profit|earn|signal)/i,
      "英文 DM 引流 + 变现关键词"
    ],
    [/free\s+(?:crypto|bitcoin|eth|nft|gift\s?cards?)\b/i, "「免费加密货币/礼品卡」模板"],
    // 2026-08 真实样本：大量「500 USDT Giveaway」Tron 假抽奖，giveaway 拼写变体（giweaway）一并覆盖
    [
      /\b\d{1,7}\s*(?:usdt|usdc|btc|eth|sol|trx|tron|xrp|doge)\b[\s\S]{0,80}g[i1](?:v|w)?e?away/i,
      "加密货币 Giveaway 假抽奖模板"
    ],
    [
      /g[i1](?:v|w)?e?away[\s\S]{0,80}\b\d{1,7}\s*(?:usdt|usdc|btc|eth|sol|trx|tron|xrp|doge)\b/i,
      "加密货币 Giveaway 假抽奖模板"
    ],
    // 要求 repost/retweet/follow 这类强互动引流动词，避免误伤日常 "like ... win" 表述
    [/(?:follow|repost|retweet)\b[\s\S]{0,60}(?:claim|win)\b/i, "关注-转发抽奖引流话术"]
  ];
  var templatedText = {
    id: "templated-text",
    check(input) {
      const haystack = [input.text, input.bio].filter(Boolean).join("\n");
      if (!haystack) {
        return null;
      }
      for (const [pattern, label] of TEMPLATED_PATTERNS) {
        if (pattern.test(haystack)) {
          return `模板化垃圾话术：${label}`;
        }
      }
      return null;
    }
  };
  var PORN_BAIT_FU_RE = /福不黑|(?:批评|评价|点评|看看|欣赏|指导)(?:一下)?我的福|我的福(?:嘛|呢)|福利(?:在主页|在简介|已备好|自取)/;
  var EROGENOUS_MARKERS = [
    [/涩|色色/, "涩"],
    [/没我骚|比我[^。]{0,8}骚/, "骚"],
    [/玩[得的]{1,2}更?开/, "玩得开"],
    [/[🍑🍒🍆💧💋🌹〕]/u, "擦边emoji"]
  ];
  var pornBaitZh = {
    id: "porn-bait-zh",
    check(input) {
      const text = [input.text, input.bio].filter(Boolean).join("\n");
      if (!text) {
        return null;
      }
      if (PORN_BAIT_FU_RE.test(text)) {
        return "「福利」引流域黄推话术";
      }
      const hits = [];
      for (const [pattern, label] of EROGENOUS_MARKERS) {
        if (pattern.test(text)) {
          hits.push(label);
          if (hits.length >= 2) {
            return `擦边引流组合话术（${hits.join("+")}）`;
          }
        }
      }
      return null;
    }
  };
  var DEFAULT_HEURISTICS = [
    defaultNameDigits,
    pornBaitZh,
    spamLinkHint,
    templatedText
  ];

  // ../../packages/detector/src/simhash.ts
  var SIMHASH_HAMMING_THRESHOLD = 2;
  var MAX_TOKEN_WEIGHT = 8;
  function simhashTokens(text) {
    const normalized = normalizeForFingerprint(text);
    if (normalized.length < MIN_FINGERPRINT_LENGTH) {
      return [];
    }
    const grams = [];
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i <= normalized.length - n; i++) {
        grams.push(normalized.slice(i, i + n));
      }
    }
    return grams;
  }
  function textToSimhash(text) {
    const tokens = simhashTokens(text);
    if (tokens.length === 0) {
      return null;
    }
    const counts = /* @__PURE__ */ new Map();
    for (const t of tokens) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const weights = [];
    for (const [token, count] of counts) {
      const w = Math.min(count, MAX_TOKEN_WEIGHT);
      if (w <= 0) {
        continue;
      }
      let h = 0x35b5e5a7n;
      for (let i = 0; i < token.length; i++) {
        h ^= BigInt(token.charCodeAt(i)) * 0x100000001b3n;
        h = h >> 8n | h << 56n;
      }
      weights.push({ hash: h & 0xffffffffffffffffn, weight: w });
    }
    const bits = new Array(64).fill(0);
    for (const { hash, weight } of weights) {
      for (let b = 0; b < 64; b++) {
        if (hash >> BigInt(b) & 1n) {
          bits[b] = (bits[b] ?? 0) + weight;
        } else {
          bits[b] = (bits[b] ?? 0) - weight;
        }
      }
    }
    let result = 0n;
    for (let b = 63; b >= 0; b--) {
      result = result << 1n | ((bits[b] ?? 0) > 0 ? 1n : 0n);
    }
    return result;
  }
  function hammingDistance(a, b) {
    let diff = a ^ b;
    let count = 0;
    while (diff !== 0n) {
      diff &= diff - 1n;
      count++;
    }
    return count;
  }
  function simhashToHex(value) {
    return value.toString(16).padStart(16, "0");
  }
  function simhashFromHex(value) {
    if (!/^[0-9a-f]{16}$/i.test(value)) {
      return null;
    }
    return BigInt(`0x${value}`);
  }

  // ../../packages/detector/src/fingerprint.ts
  var MIN_FINGERPRINT_LENGTH = 12;
  var URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)+(?:\/\S*)?/gi;
  var MENTION_RE = /@[A-Za-z0-9_]{1,15}/g;
  function normalizeForFingerprint(text) {
    return text.toLowerCase().replace(URL_RE, "fsurl").replace(MENTION_RE, "fsmention").replace(/[^\p{L}\p{N}]/gu, "");
  }
  function fingerprintText(text) {
    const value = textToSimhash(text);
    if (value === null) {
      return null;
    }
    return simhashToHex(value);
  }
  function contentFingerprint(input) {
    const text = input.text?.trim() ? input.text : input.bio;
    if (!text) {
      return null;
    }
    return fingerprintText(text);
  }

  // ../../packages/detector/src/detect.ts
  function normalizeHandle(handle) {
    return handle.trim().replace(/^@+/, "").toLowerCase();
  }
  function toHandleSet(entries) {
    const set = /* @__PURE__ */ new Set();
    for (const entry of entries) {
      const handle = typeof entry === "string" ? entry : entry.handle;
      if (typeof handle === "string") {
        const normalized = normalizeHandle(handle);
        if (normalized) {
          set.add(normalized);
        }
      }
    }
    return set;
  }
  function detect(input, options = {}) {
    const handle = normalizeHandle(input.handle);
    if (!handle) {
      return null;
    }
    if (options.list?.has(handle)) {
      return {
        handle,
        marked: true,
        source: options.listSource ?? "community-list",
        reason: "名单命中",
        ruleId: "list"
      };
    }
    if (options.simhashes?.size || options.fingerprints?.size) {
      const text = input.text?.trim() ? input.text : input.bio;
      if (text) {
        const fp = contentFingerprint({ text });
        if (fp && options.fingerprints?.has(fp)) {
          return {
            handle,
            marked: true,
            source: "fingerprint",
            reason: "已知垃圾模板 · 社区指纹命中",
            ruleId: "community-fingerprint",
            matchedFingerprint: fp
          };
        }
        if (options.simhashes?.size) {
          const hit = findNearSimhash(text, options.simhashes);
          if (hit) {
            return {
              handle,
              marked: true,
              source: "fingerprint",
              reason: "已知垃圾模板 · 话术变体（SimHash）",
              ruleId: "community-fingerprint-sim",
              matchedFingerprint: hit
            };
          }
        }
      }
    }
    if (options.domains?.size) {
      for (const link of input.links ?? []) {
        if (link.hostname && options.domains.has(link.hostname.toLowerCase())) {
          const hostname = link.hostname.toLowerCase();
          return {
            handle,
            marked: true,
            source: "domain",
            reason: `链接指向社区名单域名（${hostname}）`,
            ruleId: "community-domain"
          };
        }
      }
    }
    const heuristics = options.heuristics ?? DEFAULT_HEURISTICS;
    for (const rule of heuristics) {
      let matched;
      try {
        matched = rule.check({ ...input, handle });
      } catch {
        continue;
      }
      if (matched) {
        return {
          handle,
          marked: true,
          source: "heuristic",
          reason: `启发式：${matched}`,
          ruleId: rule.id
        };
      }
    }
    return null;
  }
  function findNearSimhash(text, simhashes) {
    const local = fingerprintText(text);
    if (!local) {
      return null;
    }
    const localBits = simhashFromHex(local);
    if (localBits === null) {
      return null;
    }
    let nearest = null;
    let nearestDist = SIMHASH_HAMMING_THRESHOLD + 1;
    for (const known of simhashes) {
      const knownBits = simhashFromHex(known);
      if (knownBits === null) {
        continue;
      }
      const dist = hammingDistance(localBits, knownBits);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = known;
      }
    }
    return nearestDist <= SIMHASH_HAMMING_THRESHOLD ? nearest : null;
  }

  // ../../packages/x-adapter/src/handle.ts
  var RESERVED_PATH_SEGMENTS = /* @__PURE__ */ new Set([
    "home",
    "explore",
    "notifications",
    "messages",
    "search",
    "settings",
    "i",
    "intent",
    "hashtag",
    "compose"
  ]);
  function extractHandleFromPath(pathname) {
    let path = pathname;
    try {
      if (!path.startsWith("/")) {
        const url = new URL(path);
        if (url.hostname !== "x.com" && url.hostname !== "twitter.com") {
          return null;
        }
        path = url.pathname;
      } else {
        path = path.split(/[?#]/)[0] ?? path;
      }
    } catch {
      return null;
    }
    const first = path.split("/").filter(Boolean)[0];
    if (!first) {
      return null;
    }
    const decoded = decodeURIComponent(first).toLowerCase();
    if (RESERVED_PATH_SEGMENTS.has(decoded)) {
      return null;
    }
    return decoded;
  }
  var CONTEXT_BY_PREFIX = [
    [/^\/home/, "timeline"],
    [/^\/search/, "search"],
    [/^\/[^/]+\/status\//, "reply"],
    [/^\/notifications|^\/messages|^\/explore/, "other"]
  ];
  function contextFromPath(pathname) {
    for (const [pattern, context] of CONTEXT_BY_PREFIX) {
      if (pattern.test(pathname)) {
        return context;
      }
    }
    return extractHandleFromPath(pathname) ? "profile" : "other";
  }

  // ../../packages/x-adapter/src/selectors/selectors.ts
  var tweetSelectors = {
    /** 单条推文容器：X 对 article + data-testid="tweet" 相当稳定。 */
    article: 'article[data-testid="tweet"]',
    /** 时间线格子（article 的外层 cell）。标注边框打在这层，绝不进 article 内部破坏其 grid 布局。 */
    timelineCell: 'div[data-testid="cellInnerDiv"]',
    /** 作者信息区（含 displayName 与 @handle 链接）。 */
    authorNameArea: '[data-testid="User-Name"]',
    /** 作者行里指向 /handle 的链接（displayName 同样包在一个用户链接里）。 */
    authorLink: '[data-testid="User-Name"] a[href^="/"]',
    /** 正文文本区。 */
    text: '[data-testid="tweetText"]',
    /**
     * 推文底部动作栏锁定锨。X 会调整按钮数量，因此不靠 CSS class：
     * 找 like/unlike 按钮后再 closest([role=group])。
     */
    actionAnchor: '[data-testid="like"], [data-testid="unlike"]',
    actionGroup: '[role="group"]'
  };

  // ../../packages/x-adapter/src/reader.ts
  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  var POST_ID_RE = /\/status\/(\d+)/;
  function extractPostId(article) {
    for (const anchor of article.querySelectorAll('a[href*="/status/"]')) {
      const match = POST_ID_RE.exec(anchor.getAttribute("href") ?? "");
      const id = match?.[1];
      if (id) {
        return id;
      }
    }
    return void 0;
  }
  var displayNameStripPatterns = /* @__PURE__ */ new Map();
  var DISPLAY_NAME_PATTERN_CACHE_MAX = 200;
  function displayNameStripPattern(handle) {
    const cached = displayNameStripPatterns.get(handle);
    if (cached) {
      return cached;
    }
    const pattern = new RegExp(`@${escapeRegExp(handle)}\\b`, "gi");
    if (displayNameStripPatterns.size >= DISPLAY_NAME_PATTERN_CACHE_MAX) {
      displayNameStripPatterns.clear();
    }
    displayNameStripPatterns.set(handle, pattern);
    return pattern;
  }
  function extractDisplayName(area, handle) {
    if (!area) {
      return void 0;
    }
    const full = area.textContent ?? "";
    const withoutHandle = full.replace(displayNameStripPattern(handle), "");
    const cleaned = withoutHandle.replace(/[\u00b7\u2022|]/g, " ").replace(/^[\s\-–—:·@]+|[\s\-–—:·@]+$/g, "");
    return cleaned || void 0;
  }
  function isInsideQuotedPost(element, article, articlePostId) {
    if (!articlePostId) {
      return false;
    }
    let current = element.parentElement;
    while (current && current !== article) {
      if (current.matches('a[href*="/status/"], [role="link"]')) {
        const statusAnchor = current.matches('a[href*="/status/"]') ? current : current.querySelector('a[href*="/status/"]');
        const nestedId = POST_ID_RE.exec(statusAnchor?.getAttribute("href") ?? "")?.[1];
        if (nestedId && nestedId !== articlePostId) {
          return true;
        }
      }
      current = current.parentElement;
    }
    return false;
  }
  function extractOwnText(article, postId) {
    for (const textEl of article.querySelectorAll(tweetSelectors.text)) {
      if (!isInsideQuotedPost(textEl, article, postId)) {
        return textEl.textContent ?? "";
      }
    }
    return "";
  }
  function extractExternalLinks(article, postId) {
    const links = /* @__PURE__ */ new Map();
    for (const anchor of article.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href") ?? "";
      let url;
      try {
        url = new URL(href, location.origin);
      } catch {
        continue;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        continue;
      }
      if (url.hostname === "x.com" || url.hostname === "twitter.com") {
        continue;
      }
      if (isInsideQuotedPost(anchor, article, postId)) {
        continue;
      }
      if (!links.has(url.href)) {
        const display = (anchor.textContent ?? "").trim();
        links.set(url.href, {
          href: url.href,
          hostname: url.hostname,
          display: display || void 0
        });
      }
    }
    return [...links.values()];
  }
  function extractFeedItem(article, context = "other") {
    const authorAnchor = article.querySelector(tweetSelectors.authorLink);
    const handle = authorAnchor ? extractHandleFromPath(authorAnchor.pathname) : null;
    if (!handle) {
      return null;
    }
    const nameArea = article.querySelector(tweetSelectors.authorNameArea);
    const postId = extractPostId(article);
    return {
      source: "x",
      postId,
      author: {
        handle,
        displayName: extractDisplayName(nameArea, handle)
      },
      text: extractOwnText(article, postId),
      links: extractExternalLinks(article, postId),
      context
    };
  }

  // ../../packages/x-adapter/src/actions/block.ts
  var X_WEB_BEARER = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  var ENDPOINTS = {
    block: "https://x.com/i/api/1.1/blocks/create.json",
    unblock: "https://x.com/i/api/1.1/blocks/destroy.json"
  };
  function readCsrfToken() {
    for (const part of document.cookie.split(";")) {
      const trimmed = part.trim();
      if (trimmed.startsWith("ct0=")) {
        return trimmed.substring("ct0=".length) || null;
      }
    }
    return null;
  }
  async function runNativeAction(type, xUserId, fetchImpl = fetch) {
    const csrf = readCsrfToken();
    if (!csrf) {
      return {
        ok: false,
        code: "missing_csrf",
        message: "ct0 cookie 不可读（未登录或页面上下文错误）"
      };
    }
    try {
      const response = await fetchImpl(ENDPOINTS[type], {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          Authorization: X_WEB_BEARER,
          "X-Twitter-Auth-Type": "OAuth2Session",
          "X-Twitter-Active-User": "yes",
          "X-Csrf-Token": csrf
        },
        body: `user_id=${encodeURIComponent(xUserId)}`
      });
      if (response.ok) {
        return { ok: true };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, code: "auth_required", message: `HTTP ${response.status}` };
      }
      if (response.status === 429) {
        return { ok: false, code: "rate_limited", message: "HTTP 429" };
      }
      return { ok: false, code: "http_error", message: `HTTP ${response.status}` };
    } catch (error) {
      return {
        ok: false,
        code: "network_error",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // ../../packages/x-adapter/src/actions/resolve-user-id.ts
  var USER_BY_SCREEN_NAME_QUERY_ID = "32pL5BWe9WKeSK1MoPvFQQ";
  var USER_FEATURES = encodeURIComponent(
    '{"hidden_profile_subscriptions_enabled":true,"profile_label_improvements_pcf_label_in_post_enabled":true,"rweb_tipjar_consumption_enabled":true,"responsive_web_graphql_exclude_directive_enabled":true,"verified_phone_label_enabled":false,"subscriptions_verification_info_is_identity_verified_enabled":true,"subscriptions_verification_info_verified_since_enabled":true,"highlights_tweets_tab_ui_enabled":true,"responsive_web_twitter_article_notes_tab_enabled":true,"subscriptions_feature_can_gift_premium":true,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true,"longform_notetweets_inline_media_enabled":false,"longform_notetweets_rich_text_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":false,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":false,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"tweet_awards_web_tipping_enabled":false,"articles_preview_enabled":false,"responsive_web_jetfuel_frame":false,"responsive_web_enhance_cards_enabled":false,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":false,"creator_subscriptions_quote_tweet_preview_enabled":false,"standardized_nudges_misinfo":false,"view_counts_everywhere_api_enabled":false,"rweb_video_timestamps_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":false,"longform_notetweets_consumption_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":false,"responsive_web_grok_share_attachment_enabled":false,"responsive_web_grok_image_annotation_enabled":false,"c9s_tweet_anatomy_moderator_badge_enabled":false,"responsive_web_grok_analysis_button_from_backend":false,"responsive_web_edit_tweet_api_enabled":false,"premium_content_api_read_enabled":false,"responsive_web_twitter_article_tweet_consumption_enabled":false}'
  );
  var FIELD_TOGGLES = encodeURIComponent('{"withAuxiliaryUserLabels":false}');
  async function resolveUserIdByHandle(handle, fetchImpl = fetch) {
    const csrf = readCsrfToken();
    if (!csrf) {
      return null;
    }
    const variables = encodeURIComponent(
      JSON.stringify({ screen_name: handle, withSafetyModeUserFields: true })
    );
    const url = `https://x.com/i/api/graphql/${USER_BY_SCREEN_NAME_QUERY_ID}/UserByScreenName?variables=${variables}&features=${USER_FEATURES}&fieldToggles=${FIELD_TOGGLES}`;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        credentials: "include",
        headers: {
          Authorization: X_WEB_BEARER,
          "X-Twitter-Auth-Type": "OAuth2Session",
          "X-Csrf-Token": csrf
        }
      });
      if (!response.ok) {
        return null;
      }
      const body = await response.json();
      const result = body.data?.user?.result;
      if (result?.__typename === "UserUnavailable" || !result?.rest_id) {
        return null;
      }
      return String(result.rest_id);
    } catch {
      return null;
    }
  }

  // ../../community/lists/official.json
  var official_default = {
    schema_version: 2,
    policy_version: 3,
    snapshot_version: "2026.09.02.1",
    generated_at: "2026-09-02T02:15:00.000Z",
    entries: [
      {
        handle: "cndon91",
        x_user_id: null,
        aliases: [],
        category: "adult_gray_traffic",
        sources: ["maintainer"],
        maintainer_note: "历史人工背书条目迁移；后续可由维护者页面更新或撤销",
        community_score: 0.25,
        report_count: 1,
        rescue_count: 0,
        net_votes: 1,
        first_seen_at: "2026-08-30T07:30:09.000Z",
        updated_at: "2026-08-30T07:30:09.000Z",
        evidence_post_ids: []
      },
      {
        handle: "crypto_teacher",
        x_user_id: null,
        aliases: [],
        category: "scam_phishing",
        sources: ["maintainer"],
        maintainer_note: "历史人工背书条目迁移；后续可由维护者页面更新或撤销",
        community_score: 0.25,
        report_count: 1,
        rescue_count: 0,
        net_votes: 1,
        first_seen_at: "2026-08-30T07:30:09.000Z",
        updated_at: "2026-08-30T07:30:09.000Z",
        evidence_post_ids: []
      },
      {
        handle: "lucky_winner99",
        x_user_id: null,
        aliases: [],
        category: "copy_paste",
        sources: ["maintainer"],
        maintainer_note: "历史人工背书条目迁移；后续可由维护者页面更新或撤销",
        community_score: 0.25,
        report_count: 1,
        rescue_count: 0,
        net_votes: 1,
        first_seen_at: "2026-08-30T07:30:09.000Z",
        updated_at: "2026-08-30T07:30:09.000Z",
        evidence_post_ids: []
      },
      {
        handle: "newaccount7",
        x_user_id: null,
        aliases: [],
        category: "bot_spam",
        sources: ["maintainer"],
        maintainer_note: "历史人工背书条目迁移；后续可由维护者页面更新或撤销",
        community_score: 0.25,
        report_count: 1,
        rescue_count: 0,
        net_votes: 1,
        first_seen_at: "2026-08-30T07:30:09.000Z",
        updated_at: "2026-08-30T07:30:09.000Z",
        evidence_post_ids: []
      },
      {
        handle: "spamking88",
        x_user_id: null,
        aliases: [],
        category: "copy_paste",
        sources: ["maintainer"],
        maintainer_note: "历史人工背书条目迁移；后续可由维护者页面更新或撤销",
        community_score: 0.25,
        report_count: 1,
        rescue_count: 0,
        net_votes: 1,
        first_seen_at: "2026-08-30T07:30:09.000Z",
        updated_at: "2026-08-30T07:30:09.000Z",
        evidence_post_ids: []
      },
      {
        handle: "trxminer07",
        x_user_id: null,
        aliases: [],
        category: "scam_phishing",
        sources: ["maintainer"],
        maintainer_note: "历史人工背书条目迁移；后续可由维护者页面更新或撤销",
        community_score: 0.25,
        report_count: 1,
        rescue_count: 0,
        net_votes: 1,
        first_seen_at: "2026-08-30T07:30:09.000Z",
        updated_at: "2026-08-30T07:30:09.000Z",
        evidence_post_ids: []
      }
    ]
  };

  // src/store.ts
  var PREFIX = "feedsieve:";
  var gm = globalThis;
  function hasGM() {
    return typeof gm.GM_getValue === "function" && typeof gm.GM_setValue === "function";
  }
  async function kvGet(key, fallback) {
    try {
      if (hasGM()) {
        const raw2 = gm.GM_getValue(key, void 0);
        return raw2 === void 0 ? fallback : raw2;
      }
      const raw = window.localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  async function kvSet(key, value) {
    try {
      if (hasGM()) {
        gm.GM_setValue(key, value);
        return;
      }
      window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
    }
  }
  async function kvDelete(key) {
    try {
      if (hasGM() && typeof gm.GM_deleteValue === "function") {
        gm.GM_deleteValue(key);
        return;
      }
      window.localStorage.removeItem(PREFIX + key);
    } catch {
    }
  }
  function kvSubscribe(key, cb) {
    if (hasGM() && typeof gm.GM_addValueChangeListener === "function") {
      const id = gm.GM_addValueChangeListener(key, (_name, _oldValue, newValue) => cb(newValue));
      return () => gm.GM_removeValueChangeListener?.(id);
    }
    return () => {
    };
  }

  // src/state.ts
  function normalize(handle) {
    return handle.trim().replace(/^@+/, "").toLowerCase();
  }
  var ALLOWLIST_KEY = "allowlist";
  async function getAllowlist() {
    const value = await kvGet(ALLOWLIST_KEY, []);
    return Array.isArray(value) ? value : [];
  }
  async function addAllowlist(handle, xUserId, evidence) {
    const normalized = normalize(handle);
    if (!normalized) return;
    const items = await getAllowlist();
    if (items.some((item) => item.handle === normalized)) return;
    items.push({
      handle: normalized,
      addedAt: Date.now(),
      ...xUserId ? { xUserId } : {},
      ...evidence?.detectionSource ? { detectionSource: evidence.detectionSource } : {},
      ...evidence?.ruleId ? { ruleId: evidence.ruleId } : {},
      ...evidence?.detectionReason ? { detectionReason: evidence.detectionReason } : {}
    });
    await kvSet(ALLOWLIST_KEY, items);
  }
  var BLOCKED_KEY = "blockedAccounts";
  async function getBlockedAccounts() {
    const value = await kvGet(BLOCKED_KEY, []);
    return Array.isArray(value) ? value : [];
  }
  async function markBlocked(handle, xUserId, evidence) {
    const normalized = normalize(handle);
    if (!normalized) return;
    const accounts = await getBlockedAccounts();
    const existing = accounts.find((a) => a.handle === normalized);
    if (existing) {
      let changed = false;
      if (!existing.xUserId && xUserId) {
        existing.xUserId = xUserId;
        changed = true;
      }
      if (evidence) {
        existing.category = evidence.category;
        existing.contentFingerprint = evidence.contentFingerprint;
        existing.linkDomains = evidence.linkDomains;
        existing.detectionSource = evidence.detectionSource ?? existing.detectionSource;
        existing.origin = evidence.origin ?? existing.origin;
        existing.communityVote = evidence.communityVote ?? existing.communityVote;
        existing.batchId = evidence.batchId ?? existing.batchId;
        changed = true;
      }
      if (changed) await kvSet(BLOCKED_KEY, accounts);
      return;
    }
    accounts.push({
      handle: normalized,
      ...xUserId ? { xUserId } : {},
      ...evidence?.category ? { category: evidence.category } : {},
      ...evidence?.contentFingerprint ? { contentFingerprint: evidence.contentFingerprint } : {},
      ...evidence?.linkDomains?.length ? { linkDomains: evidence.linkDomains } : {},
      ...evidence?.detectionSource ? { detectionSource: evidence.detectionSource } : {},
      ...evidence?.origin ? { origin: evidence.origin } : {},
      ...typeof evidence?.communityVote === "boolean" ? { communityVote: evidence.communityVote } : {},
      ...evidence?.batchId ? { batchId: evidence.batchId } : {},
      blockedAt: Date.now()
    });
    await kvSet(BLOCKED_KEY, accounts);
  }
  var USER_IDS_KEY = "userIds";
  var MAX_ENTRIES = 5e3;
  async function getUserId(handle) {
    const value = await kvGet(USER_IDS_KEY, {});
    return value.ids?.[normalize(handle)];
  }
  async function saveUserIds(entries) {
    if (entries.length === 0) return;
    const value = await kvGet(USER_IDS_KEY, {});
    const ids = value.ids ?? {};
    let changed = false;
    for (const { handle, xUserId } of entries) {
      const normalized = normalize(handle);
      if (!normalized || !xUserId) continue;
      if (ids[normalized] === xUserId) continue;
      delete ids[normalized];
      ids[normalized] = xUserId;
      changed = true;
    }
    if (!changed) return;
    const all = Object.entries(ids);
    const trimmed = all.length > MAX_ENTRIES ? Object.fromEntries(all.slice(-MAX_ENTRIES)) : ids;
    await kvSet(USER_IDS_KEY, { ids: trimmed });
  }
  var FAB_POSITION_KEY = "fabPosition";
  async function getFabPosition() {
    const raw = await kvGet(FAB_POSITION_KEY, null);
    if (!raw || typeof raw !== "object") return null;
    const candidate = raw;
    if (typeof candidate.rightPct !== "number" || typeof candidate.bottomPct !== "number" || candidate.rightPct < 0 || candidate.rightPct > 1 || candidate.bottomPct < 0 || candidate.bottomPct > 1) {
      return null;
    }
    return { rightPct: candidate.rightPct, bottomPct: candidate.bottomPct };
  }
  async function setFabPosition(position) {
    await kvSet(FAB_POSITION_KEY, position);
  }
  async function clearFabPosition() {
    await kvDelete(FAB_POSITION_KEY);
  }

  // ../../packages/community-lists/src/types.ts
  var MARK_STRENGTHS = [
    "refresh",
    "standard",
    "deep_clean"
  ];
  var DEFAULT_MARK_STRENGTH = "standard";
  function isMarkStrength(value) {
    return typeof value === "string" && MARK_STRENGTHS.includes(value);
  }

  // ../../packages/community-lists/src/validate.ts
  var SOURCES = ["community", "maintainer"];
  var CATEGORIES = /* @__PURE__ */ new Set([
    "bot_spam",
    "copy_paste",
    "ai_slop",
    "advertising",
    "adult_gray_traffic",
    "scam_phishing",
    "engagement_bait",
    "other"
  ]);
  var HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
  var USER_ID_RE = /^\d{1,20}$/;
  var POST_ID_RE2 = /^\d{1,25}$/;
  var VERSION_RE = /^\d{4}\.\d{2}\.\d{2}\.\d{1,4}$/;
  var SHA256_RE = /^[0-9a-f]{64}$/;
  var FINGERPRINT_RE = /^[0-9a-f]{16}$/;
  var HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  var MAX_EVIDENCE = 5;
  function isIsoDate(value) {
    return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
  }
  function validEvidenceList(value, itemCheck) {
    if (value === void 0 || value === null) {
      return null;
    }
    if (!Array.isArray(value) || value.length > MAX_EVIDENCE || !value.every((item) => typeof item === "string" && itemCheck(item))) {
      return null;
    }
    return value;
  }
  function parseManifest(raw) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "manifest_not_object" };
    }
    const m = raw;
    if (m.schema_version !== 2) {
      return { ok: false, error: "unsupported_schema_version" };
    }
    if (typeof m.snapshot_version !== "string" || !VERSION_RE.test(m.snapshot_version)) {
      return { ok: false, error: "invalid_snapshot_version" };
    }
    if (!isIsoDate(m.generated_at)) {
      return { ok: false, error: "invalid_generated_at" };
    }
    if (!Array.isArray(m.files) || m.files.length === 0) {
      return { ok: false, error: "manifest_files_empty" };
    }
    const files = [];
    for (const f of m.files) {
      if (typeof f !== "object" || f === null) {
        return { ok: false, error: "invalid_manifest_file" };
      }
      const file = f;
      if (typeof file.path !== "string" || typeof file.sha256 !== "string" || !SHA256_RE.test(file.sha256) || typeof file.entries !== "number" || !Number.isInteger(file.entries) || file.entries < 0) {
        return { ok: false, error: "invalid_manifest_file" };
      }
      files.push({
        path: file.path,
        sha256: file.sha256,
        entries: file.entries
      });
    }
    return {
      ok: true,
      value: {
        schema_version: 2,
        snapshot_version: m.snapshot_version,
        generated_at: m.generated_at,
        files
      }
    };
  }
  function parseSnapshotBody(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, error: "snapshot_not_json" };
    }
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "snapshot_not_object" };
    }
    const s = raw;
    if (s.schema_version !== 2) {
      return { ok: false, error: "unsupported_schema_version" };
    }
    if (typeof s.snapshot_version !== "string" || !VERSION_RE.test(s.snapshot_version)) {
      return { ok: false, error: "invalid_snapshot_version" };
    }
    if (!isIsoDate(s.generated_at)) {
      return { ok: false, error: "invalid_generated_at" };
    }
    if (!Array.isArray(s.entries)) {
      return { ok: false, error: "entries_not_array" };
    }
    const entries = [];
    const handles = /* @__PURE__ */ new Set();
    for (const item of s.entries) {
      const entry = validateEntry(item);
      if (!entry) return { ok: false, error: "invalid_snapshot_entry" };
      if (handles.has(entry.handle)) return { ok: false, error: "duplicate_snapshot_handle" };
      handles.add(entry.handle);
      entries.push(entry);
    }
    return {
      ok: true,
      value: {
        schema_version: 2,
        snapshot_version: s.snapshot_version,
        generated_at: s.generated_at,
        entries
      }
    };
  }
  function validateEntry(item) {
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const e = item;
    if (typeof e.handle !== "string" || !HANDLE_RE.test(e.handle) || typeof e.category !== "string" || !CATEGORIES.has(e.category) || !Array.isArray(e.sources) || e.sources.length === 0 || !e.sources.every((source) => SOURCES.includes(source)) || new Set(e.sources).size !== e.sources.length || typeof e.community_score !== "number" || !Number.isFinite(e.community_score) || e.community_score < 0 || e.community_score > 1 || typeof e.report_count !== "number" || !Number.isInteger(e.report_count) || e.report_count < 0 || typeof e.rescue_count !== "number" || !Number.isInteger(e.rescue_count) || e.rescue_count < 0 || typeof e.net_votes !== "number" || !Number.isInteger(e.net_votes) || e.net_votes !== e.report_count - e.rescue_count || !Array.isArray(e.evidence_post_ids) || e.evidence_post_ids.length > MAX_EVIDENCE || !e.evidence_post_ids.every((id) => typeof id === "string" && POST_ID_RE2.test(id))) {
      return null;
    }
    if (e.x_user_id !== null && e.x_user_id !== void 0 && (typeof e.x_user_id !== "string" || !USER_ID_RE.test(e.x_user_id))) {
      return null;
    }
    const sources = e.sources;
    if (sources.includes("maintainer") && (typeof e.maintainer_note !== "string" || e.maintainer_note.trim().length < 4 || e.maintainer_note.length > 240)) {
      return null;
    }
    if (e.maintainer_note !== void 0 && typeof e.maintainer_note !== "string") {
      return null;
    }
    if (!sources.includes("maintainer") && e.maintainer_note !== void 0) {
      return null;
    }
    if (!isIsoDate(e.first_seen_at) || !isIsoDate(e.updated_at)) {
      return null;
    }
    if (e.aliases !== void 0 && e.aliases !== null && (!Array.isArray(e.aliases) || !e.aliases.every((a) => typeof a === "string" && HANDLE_RE.test(a)))) {
      return null;
    }
    const fingerprints = validEvidenceList(e.fingerprints, (item2) => FINGERPRINT_RE.test(item2));
    if (e.fingerprints != null && fingerprints === null) {
      return null;
    }
    const domains = validEvidenceList(e.domains, (item2) => HOSTNAME_RE.test(item2.toLowerCase()));
    if (e.domains != null && domains === null) {
      return null;
    }
    if (e.campaign_entry_id !== void 0 && e.campaign_entry_id !== null && (typeof e.campaign_entry_id !== "string" || !HANDLE_RE.test(e.campaign_entry_id))) {
      return null;
    }
    if (e.campaign_size !== void 0 && e.campaign_size !== null && (typeof e.campaign_size !== "number" || !Number.isInteger(e.campaign_size) || e.campaign_size < 2)) {
      return null;
    }
    return {
      handle: e.handle.toLowerCase(),
      x_user_id: typeof e.x_user_id === "string" ? e.x_user_id : null,
      category: e.category,
      sources,
      ...typeof e.maintainer_note === "string" ? { maintainer_note: e.maintainer_note.trim() } : {},
      community_score: e.community_score,
      report_count: e.report_count,
      rescue_count: e.rescue_count,
      net_votes: e.net_votes,
      ...Array.isArray(e.aliases) ? { aliases: e.aliases.map((a) => a.toLowerCase()) } : {},
      ...fingerprints ? { fingerprints } : {},
      ...domains ? { domains: domains.map((d) => d.toLowerCase()) } : {},
      ...typeof e.campaign_entry_id === "string" ? { campaign_entry_id: e.campaign_entry_id.toLowerCase() } : {},
      ...typeof e.campaign_size === "number" ? { campaign_size: e.campaign_size } : {},
      first_seen_at: typeof e.first_seen_at === "string" ? e.first_seen_at : "",
      updated_at: typeof e.updated_at === "string" ? e.updated_at : "",
      evidence_post_ids: e.evidence_post_ids
    };
  }

  // ../../packages/community-lists/src/index-core.ts
  function buildIndex(snapshot) {
    const byHandle = /* @__PURE__ */ new Map();
    const byAlias = /* @__PURE__ */ new Map();
    const byUserId = /* @__PURE__ */ new Map();
    for (const entry of snapshot.entries) {
      byHandle.set(entry.handle, entry);
      for (const alias of entry.aliases ?? []) {
        if (!byAlias.has(alias)) {
          byAlias.set(alias, entry);
        }
      }
      if (entry.x_user_id) {
        byUserId.set(entry.x_user_id, entry);
      }
    }
    return {
      version: snapshot.snapshot_version,
      size: byHandle.size,
      lookup(handle, xUserId) {
        if (xUserId) {
          const byId = byUserId.get(xUserId);
          if (byId) {
            return byId;
          }
        }
        if (handle) {
          const normalized = handle.trim().replace(/^@+/, "").toLowerCase();
          return byHandle.get(normalized) ?? byAlias.get(normalized) ?? null;
        }
        return null;
      }
    };
  }

  // ../../packages/community-lists/src/hash.ts
  async function sha256Hex(input) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(input)
    );
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // ../../packages/community-lists/src/sync.ts
  var SYNC_INTERVAL_MS = 6 * 60 * 60 * 1e3;
  function workerSource(apiBase) {
    return {
      manifestUrl: `${apiBase}/v1/snapshots/latest`,
      fileUrl: (version, path) => `${apiBase}/v1/snapshots/${version}/${path}`
    };
  }
  async function syncCommunitySnapshot(options) {
    const now = options.now ?? Date.now;
    try {
      const current = await options.store.get();
      if (!options.force && current && now() - current.synced_at < SYNC_INTERVAL_MS) {
        return { status: "skipped" };
      }
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : "unknown"
      };
    }
    let lastError = { status: "error", error: "no_sources" };
    for (const source of options.sources) {
      const outcome = await syncFromSource(source, options);
      if (outcome.status !== "error") {
        return outcome;
      }
      lastError = outcome;
    }
    return lastError;
  }
  async function syncFromSource(source, options) {
    const now = options.now ?? Date.now;
    try {
      const current = await options.store.get();
      const manifestRes = await options.fetchImpl(source.manifestUrl);
      if (!manifestRes.ok) {
        return { status: "error", error: `manifest_http_${manifestRes.status}` };
      }
      const manifest = parseManifest(await manifestRes.json());
      if (!manifest.ok) {
        return { status: "error", error: manifest.error };
      }
      if (current && manifest.value.snapshot_version === current.snapshot_version) {
        await options.store.set({ ...current, synced_at: now() });
        return { status: "unchanged" };
      }
      const file = manifest.value.files.find((candidate) => candidate.path === "official.json");
      if (!file) {
        return { status: "error", error: "machine_snapshot_missing" };
      }
      const snapshotRes = await options.fetchImpl(
        source.fileUrl(manifest.value.snapshot_version, file.path)
      );
      if (!snapshotRes.ok) {
        return { status: "error", error: `snapshot_http_${snapshotRes.status}` };
      }
      const body = await snapshotRes.text();
      if (await sha256Hex(body) !== file.sha256) {
        return { status: "error", error: "checksum_mismatch" };
      }
      const snapshot = parseSnapshotBody(body);
      if (!snapshot.ok) {
        return { status: "error", error: snapshot.error };
      }
      if (snapshot.value.snapshot_version !== manifest.value.snapshot_version) {
        return { status: "error", error: "version_mismatch" };
      }
      if (snapshot.value.entries.length !== file.entries) {
        return { status: "error", error: "entry_count_mismatch" };
      }
      await options.store.set({
        snapshot_version: manifest.value.snapshot_version,
        body,
        synced_at: now()
      });
      return { status: "updated", version: manifest.value.snapshot_version };
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : "unknown"
      };
    }
  }

  // src/community.ts
  var DEFAULT_COMMUNITY_API_BASE = "https://feedsieve-api.chendahuang.com";
  var SNAPSHOT_KEY = "communitySnapshot";
  var SETTINGS_KEY = "communitySettings";
  var BUNDLED_BODY = `${JSON.stringify(official_default, null, 2)}
`;
  var BUNDLED_SNAPSHOT = {
    snapshot_version: official_default.snapshot_version,
    body: BUNDLED_BODY,
    synced_at: Date.parse(official_default.generated_at)
  };
  async function getStoredCommunitySnapshot() {
    const value = await kvGet(SNAPSHOT_KEY, null);
    if (value && typeof value.snapshot_version === "string" && typeof value.body === "string") {
      const parsed = parseSnapshotBody(value.body);
      if (parsed.ok && parsed.value.snapshot_version === value.snapshot_version) {
        return value;
      }
    }
    return null;
  }
  async function getCommunitySnapshot() {
    return await getStoredCommunitySnapshot() ?? BUNDLED_SNAPSHOT;
  }
  async function getCommunitySettings() {
    const value = await kvGet(SETTINGS_KEY, {});
    const rawBase = value["communityApiBase"];
    return {
      enabled: value["enabled"] !== false,
      strength: isMarkStrength(value["strength"]) ? value["strength"] : DEFAULT_MARK_STRENGTH,
      autoContribute: value["autoContribute"] !== false,
      communityApiBase: typeof rawBase === "string" ? rawBase : void 0
    };
  }
  async function setCommunitySettings(patch) {
    const next = { ...await getCommunitySettings(), ...patch };
    await kvSet(SETTINGS_KEY, next);
    return next;
  }
  function subscribeCommunity(onChange) {
    const unsubSnapshot = kvSubscribe(SNAPSHOT_KEY, () => onChange());
    const unsubSettings = kvSubscribe(SETTINGS_KEY, () => onChange());
    return () => {
      unsubSnapshot();
      unsubSettings();
    };
  }
  function makeResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(body),
      text: async () => body
    };
  }
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "text",
        timeout: 2e4,
        onload: (response) => {
          const body = typeof response.response === "string" ? response.response : response.responseText;
          resolve(makeResponse(response.status, body ?? ""));
        },
        onerror: () => reject(new Error("network_error")),
        ontimeout: () => reject(new Error("timeout"))
      });
    });
  }
  async function syncNow(force = false, apiBase) {
    const resolved = await resolveApiBase(apiBase);
    const outcome = await syncCommunitySnapshot({
      sources: [workerSource(resolved)],
      fetchImpl: gmFetch,
      store: {
        get: getStoredCommunitySnapshot,
        set: async (value) => kvSet(SNAPSHOT_KEY, value)
      },
      ...force ? { force: true } : {}
    });
    return outcome;
  }
  async function resolveApiBase(override) {
    const trimmed = (override ?? "").trim();
    if (trimmed) return trimmed;
    const settings2 = await getCommunitySettings();
    const fromSettings = (settings2.communityApiBase ?? "").trim();
    return fromSettings || DEFAULT_COMMUNITY_API_BASE;
  }
  async function buildRuntimeCommunity() {
    const [snapshot, settings2] = await Promise.all([getCommunitySnapshot(), getCommunitySettings()]);
    if (!settings2.enabled || !snapshot) return null;
    const parsed = parseSnapshotBody(snapshot.body);
    if (!parsed.ok) return null;
    const index = buildIndex(parsed.value);
    const handleSet = new Set(parsed.value.entries.map((entry) => entry.handle));
    const deepClean = settings2.strength === "deep_clean";
    const fingerprintSet = /* @__PURE__ */ new Set();
    const domainSet = /* @__PURE__ */ new Set();
    const campaignById = /* @__PURE__ */ new Map();
    const campaignByFingerprint = /* @__PURE__ */ new Map();
    if (deepClean) {
      for (const entry of parsed.value.entries) {
        for (const fp of entry.fingerprints ?? []) {
          fingerprintSet.add(fp);
          const campaignHandle = entry.campaign_entry_id ?? entry.handle;
          campaignByFingerprint.set(fp, campaignHandle);
        }
        for (const domain of entry.domains ?? []) {
          domainSet.add(domain);
        }
        if (entry.campaign_entry_id && entry.campaign_size) {
          campaignById.set(entry.campaign_entry_id, entry);
        }
      }
    }
    return {
      index,
      handleSet,
      fingerprintSet,
      domainSet,
      campaignById,
      campaignByFingerprint,
      version: index.version
    };
  }

  // ../../community/keyword-packs/official.json
  var official_default2 = { schema_version: 1, pack_version: "2026.09.02.5", generated_at: null, packs: [{ id: "adult_gray_traffic", name: { zh: "黄推 / 成人引流", en: "Adult bait" }, description: { zh: "福利隐语、成人内容和主页导流的完整话术", en: "Full adult-content traffic phrases" }, source_refs: ["external_sensitive_terms_reference_2026-09-02", "local_x_miss_2026-09-01"], rules: [{ id: "adult-fu-not-black", phrase: "我福不黑", name: { zh: "我福不黑", en: "我福不黑" } }, { id: "adult-benefits-profile", phrase: "福利在主页", name: { zh: "福利在主页", en: "福利在主页" } }, { id: "adult-benefits-bio", phrase: "福利在简介", name: { zh: "福利在简介", en: "福利在简介" } }, { id: "adult-tap-profile-benefits", phrase: "点击头像看福利", name: { zh: "点击头像看福利", en: "点击头像看福利" } }, { id: "adult-profile-collect-benefits", phrase: "主页自取福利", name: { zh: "主页自取福利", en: "主页自取福利" } }, { id: "adult-enter-profile-benefits", phrase: "进主页看福利", name: { zh: "进主页看福利", en: "进主页看福利" } }, { id: "adult-benefit-video-profile", phrase: "福利视频在主页", name: { zh: "福利视频在主页", en: "福利视频在主页" } }, { id: "adult-benefit-video-bio", phrase: "福利视频在简介", name: { zh: "福利视频在简介", en: "福利视频在简介" } }, { id: "adult-benefit-link-profile", phrase: "福利链接在主页", name: { zh: "福利链接在主页", en: "福利链接在主页" } }, { id: "adult-benefit-link-bio", phrase: "福利链接在简介", name: { zh: "福利链接在简介", en: "福利链接在简介" } }, { id: "adult-private-message-video", phrase: "私信看福利视频", name: { zh: "私信看福利视频", en: "私信看福利视频" } }, { id: "adult-private-message-benefit", phrase: "私信发福利视频", name: { zh: "私信发福利视频", en: "私信发福利视频" } }, { id: "adult-benefit-collection-profile", phrase: "福利合集在主页", name: { zh: "福利合集在主页", en: "福利合集在主页" } }, { id: "adult-video-collection-profile", phrase: "视频合集在主页", name: { zh: "视频合集在主页", en: "视频合集在主页" } }, { id: "adult-profile-get-benefits", phrase: "主页领取福利", name: { zh: "主页领取福利", en: "主页领取福利" } }, { id: "adult-local-door-hookup", phrase: "同城上门约炮", name: { zh: "同城上门约炮", en: "同城上门约炮" } }, { id: "adult-local-hookup", phrase: "同城约炮", name: { zh: "同城约炮", en: "同城约炮" } }, { id: "adult-door-hookup", phrase: "上门约炮", name: { zh: "上门约炮", en: "上门约炮" } }, { id: "adult-local-private-date", phrase: "同城私约", name: { zh: "同城私约", en: "同城私约" } }, { id: "adult-local-available", phrase: "同城可约", name: { zh: "同城可约", en: "同城可约" } }, { id: "adult-nearby-available", phrase: "附近可约", name: { zh: "附近可约", en: "附近可约" } }, { id: "adult-real-person-door", phrase: "真人上门", name: { zh: "真人上门", en: "真人上门" } }, { id: "adult-student-door", phrase: "学生妹上门", name: { zh: "学生妹上门", en: "学生妹上门" } }, { id: "adult-young-woman-door", phrase: "少妇上门", name: { zh: "少妇上门", en: "少妇上门" } }, { id: "adult-national-airdrop", phrase: "全国空降", name: { zh: "全国空降", en: "全国空降" } }, { id: "adult-local-airdrop", phrase: "同城空降", name: { zh: "同城空降", en: "同城空降" } }, { id: "adult-offline-private-date", phrase: "线下私约", name: { zh: "线下私约", en: "线下私约" } }, { id: "adult-terms-local-door", phrase: "同城 + 上门", name: { zh: "同城 + 上门", en: "同城 + 上门" }, terms: ["同城", "上门"], max_gap: 12 }, { id: "adult-terms-local-hookup", phrase: "同城 + 约炮", name: { zh: "同城 + 约炮", en: "同城 + 约炮" }, terms: ["同城", "约炮"], max_gap: 12 }, { id: "adult-terms-local-private-date", phrase: "同城 + 私约", name: { zh: "同城 + 私约", en: "同城 + 私约" }, terms: ["同城", "私约"], max_gap: 12 }, { id: "adult-terms-nearby-available", phrase: "附近 + 可约", name: { zh: "附近 + 可约", en: "附近 + 可约" }, terms: ["附近", "可约"], max_gap: 12 }, { id: "adult-terms-nearby-door", phrase: "附近 + 上门", name: { zh: "附近 + 上门", en: "附近 + 上门" }, terms: ["附近", "上门"], max_gap: 12 }, { id: "adult-terms-beauty-door", phrase: "美女 + 上门", name: { zh: "美女 + 上门", en: "美女 + 上门" }, terms: ["美女", "上门"], max_gap: 10 }, { id: "adult-terms-girl-door", phrase: "妹 + 上门", name: { zh: "妹 + 上门", en: "妹 + 上门" }, terms: ["妹", "上门"], max_gap: 8 }, { id: "adult-terms-student-door", phrase: "学生妹 + 上门", name: { zh: "学生妹 + 上门", en: "学生妹 + 上门" }, terms: ["学生妹", "上门"], max_gap: 10 }, { id: "adult-terms-flight-attendant-door", phrase: "空姐 + 上门", name: { zh: "空姐 + 上门", en: "空姐 + 上门" }, terms: ["空姐", "上门"], max_gap: 10 }, { id: "adult-terms-benefit-profile", phrase: "福利 + 主页", name: { zh: "福利 + 主页", en: "福利 + 主页" }, terms: ["福利", "主页"], max_gap: 12 }, { id: "adult-terms-benefit-bio", phrase: "福利 + 简介", name: { zh: "福利 + 简介", en: "福利 + 简介" }, terms: ["福利", "简介"], max_gap: 12 }, { id: "adult-terms-local-airdrop", phrase: "同城 + 空降", name: { zh: "同城 + 空降", en: "同城 + 空降" }, terms: ["同城", "空降"], max_gap: 10 }, { id: "adult-gray-traffic-7842d12511f5a4f1", phrase: "多人运动", name: { zh: "多人运动", en: "多人运动" } }, { id: "adult-gray-traffic-0e0d085a32686059", phrase: "羞羞", name: { zh: "羞羞", en: "羞羞" } }, { id: "adult-gray-traffic-e3f1e193dcbd573d", phrase: "素质男", name: { zh: "素质男", en: "素质男" } }, { id: "adult-gray-traffic-feffd452f2037139", phrase: "无码", name: { zh: "无码", en: "无码" } }, { id: "adult-gray-traffic-e54f10c671f4bbba", phrase: "绿帽", name: { zh: "绿帽", en: "绿帽" } }, { id: "adult-gray-traffic-522d65c98381d854", phrase: "流出", name: { zh: "流出", en: "流出" } }, { id: "adult-gray-traffic-39c13661882e7b08", phrase: "素人", name: { zh: "素人", en: "素人" } }, { id: "adult-gray-traffic-da2024c66e61e968", phrase: "未满", name: { zh: "未满", en: "未满" } }, { id: "adult-gray-traffic-8d1bc21a642ef599", phrase: "裸体", name: { zh: "裸体", en: "裸体" } }, { id: "adult-gray-traffic-e51834341b405b42", phrase: "性瘾", name: { zh: "性瘾", en: "性瘾" } }, { id: "adult-gray-traffic-1574b2157a28a423", phrase: "阿姨", name: { zh: "阿姨", en: "阿姨" } }, { id: "adult-gray-traffic-a8a2882ea4ffe2d7", phrase: "空姐", name: { zh: "空姐", en: "空姐" } }, { id: "adult-gray-traffic-d4af546db9ce3add", phrase: "幼师", name: { zh: "幼师", en: "幼师" } }, { id: "adult-gray-traffic-29845368f0649b29", phrase: "性交", name: { zh: "性交", en: "性交" } }, { id: "adult-gray-traffic-e998241d6861ff3f", phrase: "性爱", name: { zh: "性爱", en: "性爱" } }, { id: "adult-gray-traffic-8f18c4fb1b2d7920", phrase: "口交", name: { zh: "口交", en: "口交" } }, { id: "adult-gray-traffic-609377a051e6e846", phrase: "乳交", name: { zh: "乳交", en: "乳交" } }, { id: "adult-gray-traffic-1f8a615a570f0639", phrase: "阴道", name: { zh: "阴道", en: "阴道" } }, { id: "adult-gray-traffic-287bb9965653f73d", phrase: "阴茎", name: { zh: "阴茎", en: "阴茎" } }, { id: "adult-gray-traffic-c46177f4680a1e88", phrase: "胸部", name: { zh: "胸部", en: "胸部" } }, { id: "adult-gray-traffic-268f83084a1f14ca", phrase: "乳房", name: { zh: "乳房", en: "乳房" } }, { id: "adult-gray-traffic-3f6c8cf28a4d72bc", phrase: "乳头", name: { zh: "乳头", en: "乳头" } }, { id: "adult-gray-traffic-aa289d65be1a57f5", phrase: "肛交", name: { zh: "肛交", en: "肛交" } }, { id: "adult-gray-traffic-16aa401ba627ec6a", phrase: "卖淫", name: { zh: "卖淫", en: "卖淫" } }, { id: "adult-gray-traffic-055dc1f10b45bac7", phrase: "妓女", name: { zh: "妓女", en: "妓女" } }, { id: "adult-gray-traffic-804416e83097e8c2", phrase: "嫖娼", name: { zh: "嫖娼", en: "嫖娼" } }, { id: "adult-gray-traffic-3832f180636fb9ea", phrase: "性服务", name: { zh: "性服务", en: "性服务" } }, { id: "adult-gray-traffic-ed8f873356844078", phrase: "性交易", name: { zh: "性交易", en: "性交易" } }, { id: "adult-gray-traffic-048b0743a8e2fd6a", phrase: "淫秽", name: { zh: "淫秽", en: "淫秽" } }, { id: "adult-gray-traffic-348a19351eb16873", phrase: "淫乱", name: { zh: "淫乱", en: "淫乱" } }, { id: "adult-gray-traffic-45ac0fbd123f359f", phrase: "援交", name: { zh: "援交", en: "援交" } }, { id: "adult-gray-traffic-fa5c4a73a63a1799", phrase: "做爱", name: { zh: "做爱", en: "做爱" } }, { id: "adult-gray-traffic-0290ae5131ec7c77", phrase: "肛门", name: { zh: "肛门", en: "肛门" } }, { id: "adult-gray-traffic-3bb0ed5821842e4a", phrase: "乱伦", name: { zh: "乱伦", en: "乱伦" } }, { id: "adult-gray-traffic-cfe092ca25808239", phrase: "迷奸", name: { zh: "迷奸", en: "迷奸" } }, { id: "adult-gray-traffic-87809878bddd9ccd", phrase: "强奸", name: { zh: "强奸", en: "强奸" } }, { id: "adult-gray-traffic-1079799056cac56a", phrase: "春药", name: { zh: "春药", en: "春药" } }, { id: "adult-gray-traffic-b2f05ff893b58234", phrase: "裸照", name: { zh: "裸照", en: "裸照" } }, { id: "adult-gray-traffic-444485725ede9d20", phrase: "情色", name: { zh: "情色", en: "情色" } }, { id: "adult-gray-traffic-edf0dcf51e4db76f", phrase: "伦理", name: { zh: "伦理", en: "伦理" } }, { id: "adult-gray-traffic-cf4cd06c4ad7cda5", phrase: "三级", name: { zh: "三级", en: "三级" } }, { id: "adult-gray-traffic-877572064da8e9ac", phrase: "AV女优", name: { zh: "AV女优", en: "AV女优" } }, { id: "adult-gray-traffic-23f55efa45415fdc", phrase: "AV男优", name: { zh: "AV男优", en: "AV男优" } }, { id: "adult-gray-traffic-d947cc2e0d9621f8", phrase: "性感", name: { zh: "性感", en: "性感" } }, { id: "adult-gray-traffic-bc92f601167cae87", phrase: "诱惑", name: { zh: "诱惑", en: "诱惑" } }, { id: "adult-gray-traffic-49b57e52e99ff914", phrase: "约炮", name: { zh: "约炮", en: "约炮" } }, { id: "adult-gray-traffic-63a18010c746275f", phrase: "性器", name: { zh: "性器", en: "性器" } }, { id: "adult-gray-traffic-e1a5f8eba0b4f3ac", phrase: "性行为", name: { zh: "性行为", en: "性行为" } }, { id: "adult-gray-traffic-906c726c991ff3e1", phrase: "性高潮", name: { zh: "性高潮", en: "性高潮" } }, { id: "adult-gray-traffic-2e92bf94af1b468a", phrase: "xxoo", name: { zh: "xxoo", en: "xxoo" } }, { id: "adult-gray-traffic-48449310f847748c", phrase: "处女", name: { zh: "处女", en: "处女" } }, { id: "adult-gray-traffic-fc42ccbaebce4a79", phrase: "处男", name: { zh: "处男", en: "处男" } }, { id: "adult-gray-traffic-f887e9df70584b8c", phrase: "婬", name: { zh: "婬", en: "婬" } }, { id: "adult-gray-traffic-852601d7b6b71ed7", phrase: "鸡巴", name: { zh: "鸡巴", en: "鸡巴" } }, { id: "adult-gray-traffic-11b21557f32bef6c", phrase: "阴囊", name: { zh: "阴囊", en: "阴囊" } }, { id: "adult-gray-traffic-92524c5b99858853", phrase: "阴部", name: { zh: "阴部", en: "阴部" } }, { id: "adult-gray-traffic-a5c0715da42310b3", phrase: "阴唇", name: { zh: "阴唇", en: "阴唇" } }, { id: "adult-gray-traffic-6bd0d3b8c8a477bc", phrase: "深喉", name: { zh: "深喉", en: "深喉" } }, { id: "adult-gray-traffic-865be665f848ee6e", phrase: "乳沟", name: { zh: "乳沟", en: "乳沟" } }, { id: "adult-gray-traffic-e49225ed0dc849b0", phrase: "双乳", name: { zh: "双乳", en: "双乳" } }, { id: "adult-gray-traffic-2eeed1adb3cc4cba", phrase: "脱衣", name: { zh: "脱衣", en: "脱衣" } }, { id: "adult-gray-traffic-6339d66a1807b2bf", phrase: "自慰", name: { zh: "自慰", en: "自慰" } }, { id: "adult-gray-traffic-401acab9c5b77481", phrase: "生殖器", name: { zh: "生殖器", en: "生殖器" } }, { id: "adult-gray-traffic-3085274827e84a85", phrase: "性器官", name: { zh: "性器官", en: "性器官" } }, { id: "adult-gray-traffic-b531c59be1f65551", phrase: "色诱", name: { zh: "色诱", en: "色诱" } }, { id: "adult-gray-traffic-96147b64775d5222", phrase: "情欲", name: { zh: "情欲", en: "情欲" } }, { id: "adult-gray-traffic-5dc35cce1ef26131", phrase: "色色", name: { zh: "色色", en: "色色" } }, { id: "adult-gray-traffic-7d0737df3df13576", phrase: "肉体", name: { zh: "肉体", en: "肉体" } }, { id: "adult-gray-traffic-23fb072c4b50ac4a", phrase: "性生活", name: { zh: "性生活", en: "性生活" } }, { id: "adult-gray-traffic-2bdcf7e3d7949fa8", phrase: "淫荡", name: { zh: "淫荡", en: "淫荡" } }, { id: "adult-gray-traffic-5b6115c5e5131392", phrase: "滥交", name: { zh: "滥交", en: "滥交" } }, { id: "adult-gray-traffic-b2c42d7b5cca0a46", phrase: "嫖客", name: { zh: "嫖客", en: "嫖客" } }, { id: "adult-gray-traffic-52ae1b8b2f9c9aa4", phrase: "猥亵", name: { zh: "猥亵", en: "猥亵" } }, { id: "adult-gray-traffic-f9c8560b2ccdb54f", phrase: "裸体照片", name: { zh: "裸体照片", en: "裸体照片" } }, { id: "adult-gray-traffic-aafafa7690fabc9f", phrase: "艳照", name: { zh: "艳照", en: "艳照" } }, { id: "adult-gray-traffic-d4c6f4a0f46120ed", phrase: "色狼", name: { zh: "色狼", en: "色狼" } }, { id: "adult-gray-traffic-f987422aa47f1938", phrase: "换妻", name: { zh: "换妻", en: "换妻" } }, { id: "adult-gray-traffic-3e58aa8710ba1d3a", phrase: "出轨", name: { zh: "出轨", en: "出轨" } }, { id: "adult-gray-traffic-5d3c8acaa9d1748d", phrase: "同房", name: { zh: "同房", en: "同房" } }, { id: "adult-gray-traffic-861dd92b7560768a", phrase: "电影色情", name: { zh: "电影色情", en: "电影色情" } }, { id: "adult-gray-traffic-76e62f046e3055cc", phrase: "爱爱", name: { zh: "爱爱", en: "爱爱" } }, { id: "adult-gray-traffic-be3e71b52cf28504", phrase: "现代情色", name: { zh: "现代情色", en: "现代情色" } }, { id: "adult-gray-traffic-2872a2423b99c00b", phrase: "文学情色", name: { zh: "文学情色", en: "文学情色" } }, { id: "adult-gray-traffic-83325b8aa35cd61b", phrase: "丝袜", name: { zh: "丝袜", en: "丝袜" } }, { id: "adult-gray-traffic-c01dc884cf268927", phrase: "少妇", name: { zh: "少妇", en: "少妇" } }, { id: "adult-gray-traffic-89f1a482f0342a91", phrase: "熟女", name: { zh: "熟女", en: "熟女" } }, { id: "adult-gray-traffic-0f214cd6cc1c4973", phrase: "SM调教", name: { zh: "SM调教", en: "SM调教" } }, { id: "adult-gray-traffic-2b2b654c014074b6", phrase: "SM舞会", name: { zh: "SM舞会", en: "SM舞会" } }, { id: "adult-gray-traffic-533afd329d106184", phrase: "SM虐恋", name: { zh: "SM虐恋", en: "SM虐恋" } }, { id: "adult-gray-traffic-16722f43160a13cb", phrase: "SM全明星", name: { zh: "SM全明星", en: "SM全明星" } }, { id: "adult-gray-traffic-1d0f6d6674457668", phrase: "吞精", name: { zh: "吞精", en: "吞精" } }, { id: "adult-gray-traffic-fb210f08f6f30c1f", phrase: "性虐待", name: { zh: "性虐待", en: "性虐待" } }, { id: "adult-gray-traffic-d5373ec8bce92744", phrase: "偷窥", name: { zh: "偷窥", en: "偷窥" } }, { id: "adult-gray-traffic-eef05f2097c2100c", phrase: "淫水", name: { zh: "淫水", en: "淫水" } }, { id: "adult-gray-traffic-a4c8e25ccf1e31cc", phrase: "性欲", name: { zh: "性欲", en: "性欲" } }, { id: "adult-gray-traffic-eefca5d7436ce86b", phrase: "轮奸", name: { zh: "轮奸", en: "轮奸" } }, { id: "adult-gray-traffic-741d8f62eb9bf999", phrase: "换媳", name: { zh: "换媳", en: "换媳" } }, { id: "adult-gray-traffic-47c5ddc3d3c4e353", phrase: "脱裤", name: { zh: "脱裤", en: "脱裤" } }, { id: "adult-gray-traffic-07b8f3a516df5ade", phrase: "阴道口", name: { zh: "阴道口", en: "阴道口" } }, { id: "adult-gray-traffic-b86f18d8714487b6", phrase: "阳具", name: { zh: "阳具", en: "阳具" } }, { id: "adult-gray-traffic-e055050e860dc0ba", phrase: "阴茎勃起", name: { zh: "阴茎勃起", en: "阴茎勃起" } }, { id: "adult-gray-traffic-24d894eab18fc851", phrase: "高潮", name: { zh: "高潮", en: "高潮" } }, { id: "adult-gray-traffic-09f5ef68b2c4a033", phrase: "兽交", name: { zh: "兽交", en: "兽交" } }, { id: "adult-gray-traffic-bbe562b9e3a8ee85", phrase: "各种姿势", name: { zh: "各种姿势", en: "各种姿势" } }, { id: "adult-gray-traffic-ff6af044913f7636", phrase: "少男少女", name: { zh: "少男少女", en: "少男少女" } }, { id: "adult-gray-traffic-61d1ee182908aa14", phrase: "美女图片", name: { zh: "美女图片", en: "美女图片" } }, { id: "adult-gray-traffic-da302cdd5e1d0ab8", phrase: "拉拉香港", name: { zh: "拉拉香港", en: "拉拉香港" } }, { id: "adult-gray-traffic-66a50891683e6dfc", phrase: "伦图", name: { zh: "伦图", en: "伦图" } }, { id: "adult-gray-traffic-d5af8cdb08e2eae9", phrase: "鬼畜抄", name: { zh: "鬼畜抄", en: "鬼畜抄" } }, { id: "adult-gray-traffic-1d90bda6316e2514", phrase: "淫赶", name: { zh: "淫赶", en: "淫赶" } }, { id: "adult-gray-traffic-ed9d7bcc53d63cfd", phrase: "三陪", name: { zh: "三陪", en: "三陪" } }, { id: "adult-gray-traffic-5cc272fc10435ea2", phrase: "双性恋", name: { zh: "双性恋", en: "双性恋" } }, { id: "adult-gray-traffic-9081db84b5859ab4", phrase: "高清性愛", name: { zh: "高清性愛", en: "高清性愛" } }, { id: "adult-gray-traffic-db9738d5263e72ad", phrase: "性爱图", name: { zh: "性爱图", en: "性爱图" } }, { id: "adult-gray-traffic-2f6719eec79a99c4", phrase: "性爱视", name: { zh: "性爱视", en: "性爱视" } }, { id: "adult-gray-traffic-886036393c56f3f5", phrase: "性爱小电影", name: { zh: "性爱小电影", en: "性爱小电影" } }, { id: "adult-gray-traffic-bbd7ed3b0495c92a", phrase: "性爱动态图", name: { zh: "性爱动态图", en: "性爱动态图" } }, { id: "adult-gray-traffic-5fe2e275867beca5", phrase: "性爱动漫", name: { zh: "性爱动漫", en: "性爱动漫" } }, { id: "adult-gray-traffic-c2c617ee403dd61e", phrase: "性爱姿势", name: { zh: "性爱姿势", en: "性爱姿势" } }, { id: "adult-gray-traffic-ba4b4b0dda9c12a2", phrase: "性爱插图", name: { zh: "性爱插图", en: "性爱插图" } }, { id: "adult-gray-traffic-77a9bd96a8842ba8", phrase: "成人文学", name: { zh: "成人文学", en: "成人文学" } }, { id: "adult-gray-traffic-6137d42c5a05a066", phrase: "成人漫画", name: { zh: "成人漫画", en: "成人漫画" } }, { id: "adult-gray-traffic-5fddb39145fe0acf", phrase: "成人小说", name: { zh: "成人小说", en: "成人小说" } }, { id: "adult-gray-traffic-3acd618d1ffe050c", phrase: "情色视频", name: { zh: "情色视频", en: "情色视频" } }, { id: "adult-gray-traffic-8878a711b658aaa4", phrase: "情色图片", name: { zh: "情色图片", en: "情色图片" } }, { id: "adult-gray-traffic-4a8dbea08c8d76a5", phrase: "裸聊", name: { zh: "裸聊", en: "裸聊" } }, { id: "adult-gray-traffic-2c1ec0a585d92d19", phrase: "裸聊视频", name: { zh: "裸聊视频", en: "裸聊视频" } }, { id: "adult-gray-traffic-8c3dd37fb4619dba", phrase: "淫兽", name: { zh: "淫兽", en: "淫兽" } }, { id: "adult-gray-traffic-f9fecbc34efd474b", phrase: "淫虫", name: { zh: "淫虫", en: "淫虫" } }, { id: "adult-gray-traffic-fc27d666e5e53e61", phrase: "淫蕩", name: { zh: "淫蕩", en: "淫蕩" } }, { id: "adult-gray-traffic-f0432346f517822b", phrase: "淫妇", name: { zh: "淫妇", en: "淫妇" } }, { id: "adult-gray-traffic-e98d99be69f3bb42", phrase: "淫姐", name: { zh: "淫姐", en: "淫姐" } }, { id: "adult-gray-traffic-841e2d456fea14eb", phrase: "淫浪", name: { zh: "淫浪", en: "淫浪" } }, { id: "adult-gray-traffic-9e41f1f97361a4b2", phrase: "淫流", name: { zh: "淫流", en: "淫流" } }, { id: "adult-gray-traffic-8729d5023d4091ab", phrase: "淫糜", name: { zh: "淫糜", en: "淫糜" } }, { id: "adult-gray-traffic-d2164ef3ca171424", phrase: "淫魔", name: { zh: "淫魔", en: "淫魔" } }, { id: "adult-gray-traffic-c5cda39783842137", phrase: "淫母", name: { zh: "淫母", en: "淫母" } }, { id: "adult-gray-traffic-8151aacc6c2a86a8", phrase: "淫女", name: { zh: "淫女", en: "淫女" } }, { id: "adult-gray-traffic-c9f4e80f715ecedc", phrase: "淫妻", name: { zh: "淫妻", en: "淫妻" } }, { id: "adult-gray-traffic-aa92ed0164f24aa0", phrase: "淫情", name: { zh: "淫情", en: "淫情" } }, { id: "adult-gray-traffic-09ef58ae47702a50", phrase: "淫肉", name: { zh: "淫肉", en: "淫肉" } }, { id: "adult-gray-traffic-0da8512f7dfadd0e", phrase: "淫乳", name: { zh: "淫乳", en: "淫乳" } }, { id: "adult-gray-traffic-84e55a5e0fa259bc", phrase: "淫色", name: { zh: "淫色", en: "淫色" } }, { id: "adult-gray-traffic-b51e54b4433ad696", phrase: "淫声", name: { zh: "淫声", en: "淫声" } }, { id: "adult-gray-traffic-3cd10237cfe8d7f4", phrase: "淫娃", name: { zh: "淫娃", en: "淫娃" } }, { id: "adult-gray-traffic-86398c999bb4c5dc", phrase: "淫液", name: { zh: "淫液", en: "淫液" } }, { id: "adult-gray-traffic-791ad82c20f19545", phrase: "淫照", name: { zh: "淫照", en: "淫照" } }, { id: "adult-gray-traffic-2f44693635a063f5", phrase: "幼齿", name: { zh: "幼齿", en: "幼齿" } }, { id: "adult-gray-traffic-14be5ce9ddab6acf", phrase: "幼交", name: { zh: "幼交", en: "幼交" } }, { id: "adult-gray-traffic-64c2c582415e7cfc", phrase: "幼女", name: { zh: "幼女", en: "幼女" } }, { id: "adult-gray-traffic-4984054cf0907593", phrase: "梦幻西游性爱版", name: { zh: "梦幻西游性爱版", en: "梦幻西游性爱版" } }, { id: "adult-gray-traffic-a82f316fd18b13e1", phrase: "禁室培欲", name: { zh: "禁室培欲", en: "禁室培欲" } }, { id: "adult-gray-traffic-14652d9cfafc9784", phrase: "性感沙滩", name: { zh: "性感沙滩", en: "性感沙滩" } }, { id: "adult-gray-traffic-498bb95702491458", phrase: "美女斗地主", name: { zh: "美女斗地主", en: "美女斗地主" } }, { id: "adult-gray-traffic-de4a8d6f8b1c88d9", phrase: "少妇自慰", name: { zh: "少妇自慰", en: "少妇自慰" } }, { id: "adult-gray-traffic-8023dfa9ef959f56", phrase: "人妻熟女", name: { zh: "人妻熟女", en: "人妻熟女" } }, { id: "adult-gray-traffic-a63e7166c427be3d", phrase: "寂寞少妇", name: { zh: "寂寞少妇", en: "寂寞少妇" } }, { id: "adult-gray-traffic-6b5133d096cbb9b1", phrase: "美女裸聊", name: { zh: "美女裸聊", en: "美女裸聊" } }, { id: "adult-gray-traffic-e02c56b5a1a7abc7", phrase: "日本AV女优", name: { zh: "日本AV女优", en: "日本AV女优" } }, { id: "adult-gray-traffic-435440b82fb5e424", phrase: "日本拉拉", name: { zh: "日本拉拉", en: "日本拉拉" } }, { id: "adult-gray-traffic-793f763d6852978d", phrase: "日本SM调教", name: { zh: "日本SM调教", en: "日本SM调教" } }, { id: "adult-gray-traffic-54905ae44e4ee7a7", phrase: "色即是空", name: { zh: "色即是空", en: "色即是空" } }, { id: "adult-gray-traffic-722a86bf05ee7081", phrase: "四房色播", name: { zh: "四房色播", en: "四房色播" } }, { id: "adult-gray-traffic-5709c9d081d6222b", phrase: "爱情岛论坛", name: { zh: "爱情岛论坛", en: "爱情岛论坛" } }, { id: "adult-gray-traffic-40f081498c60e7a0", phrase: "爽死我了", name: { zh: "爽死我了", en: "爽死我了" } }, { id: "adult-gray-traffic-356a5f61bec7c62e", phrase: "男女公关", name: { zh: "男女公关", en: "男女公关" } }, { id: "adult-gray-traffic-403734d4b879000e", phrase: "欧美BT", name: { zh: "欧美BT", en: "欧美BT" } }, { id: "adult-gray-traffic-110cf0d556583b2f", phrase: "成人杂志", name: { zh: "成人杂志", en: "成人杂志" } }, { id: "adult-gray-traffic-bae9189bd39939dd", phrase: "激情打炮", name: { zh: "激情打炮", en: "激情打炮" } }, { id: "adult-gray-traffic-593573309b9be294", phrase: "性息", name: { zh: "性息", en: "性息" } }, { id: "adult-gray-traffic-512fc764fa3094fe", phrase: "成人用品", name: { zh: "成人用品", en: "成人用品" } }, { id: "adult-gray-traffic-b5f9ba7dff858e3b", phrase: "情趣内衣", name: { zh: "情趣内衣", en: "情趣内衣" } }, { id: "adult-gray-traffic-87801412ff139d00", phrase: "情色成人", name: { zh: "情色成人", en: "情色成人" } }, { id: "adult-gray-traffic-25ec86820c63a7a4", phrase: "视频聊天", name: { zh: "视频聊天", en: "视频聊天" } }, { id: "adult-gray-traffic-02c30a7c94947a90", phrase: "视频美女", name: { zh: "视频美女", en: "视频美女" } }, { id: "adult-gray-traffic-9feedaf086f0cf2c", phrase: "一夜情", name: { zh: "一夜情", en: "一夜情" } }, { id: "adult-gray-traffic-3a012366928806f5", phrase: "性伴侣", name: { zh: "性伴侣", en: "性伴侣" } }, { id: "adult-gray-traffic-bd195dc2214f8070", phrase: "两性知识", name: { zh: "两性知识", en: "两性知识" } }, { id: "adult-gray-traffic-c3a0840a781e44bd", phrase: "成年片", name: { zh: "成年片", en: "成年片" } }, { id: "adult-gray-traffic-31681826704ad2d5", phrase: "情色电影", name: { zh: "情色电影", en: "情色电影" } }, { id: "adult-gray-traffic-24edfb49d94ad63b", phrase: "成人电影", name: { zh: "成人电影", en: "成人电影" } }, { id: "adult-gray-traffic-73e738ff002922f8", phrase: "成人片", name: { zh: "成人片", en: "成人片" } }, { id: "adult-gray-traffic-77a612246dcc75f8", phrase: "鸡吧", name: { zh: "鸡吧", en: "鸡吧" } }, { id: "adult-gray-traffic-3602bb450e53dc04", phrase: "肛洞", name: { zh: "肛洞", en: "肛洞" } }, { id: "adult-gray-traffic-cec445b92550c3bc", phrase: "双峰", name: { zh: "双峰", en: "双峰" } }, { id: "adult-gray-traffic-38daa9df4f93f116", phrase: "乳神", name: { zh: "乳神", en: "乳神" } }, { id: "adult-gray-traffic-9d13435637f6572c", phrase: "肉弹", name: { zh: "肉弹", en: "肉弹" } }, { id: "adult-gray-traffic-b3d5a7a7b052f765", phrase: "陰核", name: { zh: "陰核", en: "陰核" } }, { id: "adult-gray-traffic-209409026aab609a", phrase: "摸奶门", name: { zh: "摸奶门", en: "摸奶门" } }, { id: "adult-gray-traffic-b2cf11df1889d1cc", phrase: "肉缝", name: { zh: "肉缝", en: "肉缝" } }, { id: "adult-gray-traffic-77f87e83a9a9ec6a", phrase: "破处", name: { zh: "破处", en: "破处" } }, { id: "adult-gray-traffic-b3d51967db7049df", phrase: "幼b", name: { zh: "幼b", en: "幼b" } }, { id: "adult-gray-traffic-11013528c9226ac9", phrase: "幼逼", name: { zh: "幼逼", en: "幼逼" } }, { id: "adult-gray-traffic-bb70beadeb7db709", phrase: "偷拍", name: { zh: "偷拍", en: "偷拍" } }, { id: "adult-gray-traffic-825da03554eac018", phrase: "有码", name: { zh: "有码", en: "有码" } }, { id: "adult-gray-traffic-a8f1eb789e2d4dde", phrase: "魅惑", name: { zh: "魅惑", en: "魅惑" } }, { id: "adult-gray-traffic-a1819229451c960d", phrase: "情色小说", name: { zh: "情色小说", en: "情色小说" } }, { id: "adult-gray-traffic-e27132af473860c0", phrase: "日本AV", name: { zh: "日本AV", en: "日本AV" } }, { id: "adult-gray-traffic-3b33724050149cd8", phrase: "无码AV", name: { zh: "无码AV", en: "无码AV" } }, { id: "adult-gray-traffic-5e4be82e6eea38f3", phrase: "黄色网站", name: { zh: "黄色网站", en: "黄色网站" } }, { id: "adult-gray-traffic-7263e2eaef634fdc", phrase: "性爱电影", name: { zh: "性爱电影", en: "性爱电影" } }, { id: "adult-gray-traffic-8bfa899191c7bdb7", phrase: "免费A片", name: { zh: "免费A片", en: "免费A片" } }, { id: "adult-gray-traffic-821d324c31ad29e2", phrase: "性爱图片", name: { zh: "性爱图片", en: "性爱图片" } }, { id: "adult-gray-traffic-611f7690126cb0c1", phrase: "性交图片", name: { zh: "性交图片", en: "性交图片" } }, { id: "adult-gray-traffic-03575be93fb35d99", phrase: "人体摄影", name: { zh: "人体摄影", en: "人体摄影" } }, { id: "adult-gray-traffic-f7722af407934d37", phrase: "艳舞女郎", name: { zh: "艳舞女郎", en: "艳舞女郎" } }, { id: "adult-gray-traffic-e7cf5cae7b3bf96c", phrase: "淫乱熟女", name: { zh: "淫乱熟女", en: "淫乱熟女" } }, { id: "adult-gray-traffic-0ef55bd5f2d93ba7", phrase: "嫩B", name: { zh: "嫩B", en: "嫩B" } }, { id: "adult-gray-traffic-28008a4584c84eeb", phrase: "淫虫电影", name: { zh: "淫虫电影", en: "淫虫电影" } }, { id: "adult-gray-traffic-5960bf4d72d2190e", phrase: "日本淫荡美少女", name: { zh: "日本淫荡美少女", en: "日本淫荡美少女" } }, { id: "adult-gray-traffic-22f95670386c8b39", phrase: "日本淫电影", name: { zh: "日本淫电影", en: "日本淫电影" } }, { id: "adult-gray-traffic-1148fa6481000a11", phrase: "肛门喷水", name: { zh: "肛门喷水", en: "肛门喷水" } }, { id: "adult-gray-traffic-9d8541c2277e5821", phrase: "菊花洞", name: { zh: "菊花洞", en: "菊花洞" } }, { id: "adult-gray-traffic-8d8ee058ab47c84b", phrase: "腋毛女", name: { zh: "腋毛女", en: "腋毛女" } }, { id: "adult-gray-traffic-57ec07d071595bf0", phrase: "颜射", name: { zh: "颜射", en: "颜射" } }, { id: "adult-gray-traffic-75a409ac5140aff7", phrase: "淫荡笑话", name: { zh: "淫荡笑话", en: "淫荡笑话" } }, { id: "adult-gray-traffic-ce8c80efc298a759", phrase: "酒瓶插入", name: { zh: "酒瓶插入", en: "酒瓶插入" } }, { id: "adult-gray-traffic-04a791c016791fd9", phrase: "乳晕", name: { zh: "乳晕", en: "乳晕" } }, { id: "adult-gray-traffic-87ef948833cafd7e", phrase: "春宫", name: { zh: "春宫", en: "春宫" } }, { id: "adult-gray-traffic-8c1a39086f1b9951", phrase: "骚女", name: { zh: "骚女", en: "骚女" } }, { id: "adult-gray-traffic-eb40e0be36d9a0ac", phrase: "背德", name: { zh: "背德", en: "背德" } }, { id: "adult-gray-traffic-a65ddd029ec79a81", phrase: "乱交", name: { zh: "乱交", en: "乱交" } }, { id: "adult-gray-traffic-fdbdcc82cceffa31", phrase: "爱爱视频", name: { zh: "爱爱视频", en: "爱爱视频" } }, { id: "adult-gray-traffic-27b1b4daa13e0a68", phrase: "性爱贴图", name: { zh: "性爱贴图", en: "性爱贴图" } }, { id: "adult-gray-traffic-0d501e9b4dbc4779", phrase: "按摩棒", name: { zh: "按摩棒", en: "按摩棒" } }, { id: "adult-gray-traffic-0a9795a17550af38", phrase: "拔出来", name: { zh: "拔出来", en: "拔出来" } }, { id: "adult-gray-traffic-14e80f768e02ce00", phrase: "爆草", name: { zh: "爆草", en: "爆草" } }, { id: "adult-gray-traffic-908e686854d1b622", phrase: "包二奶", name: { zh: "包二奶", en: "包二奶" } }, { id: "adult-gray-traffic-3ce0e6aa8b3438b4", phrase: "暴干", name: { zh: "暴干", en: "暴干" } }, { id: "adult-gray-traffic-74d069077b4cfe8e", phrase: "暴奸", name: { zh: "暴奸", en: "暴奸" } }, { id: "adult-gray-traffic-b1648c034f469b16", phrase: "暴乳", name: { zh: "暴乳", en: "暴乳" } }, { id: "adult-gray-traffic-9df46b9e4ce7cb43", phrase: "爆乳", name: { zh: "爆乳", en: "爆乳" } }, { id: "adult-gray-traffic-fd917b446b3f15ff", phrase: "暴淫", name: { zh: "暴淫", en: "暴淫" } }, { id: "adult-gray-traffic-4bcf0b2ebe42d2d3", phrase: "屄", name: { zh: "屄", en: "屄" } }, { id: "adult-gray-traffic-beea215ad136eaca", phrase: "被操", name: { zh: "被操", en: "被操" } }, { id: "adult-gray-traffic-b18c23ce6959ee7f", phrase: "被插", name: { zh: "被插", en: "被插" } }, { id: "adult-gray-traffic-577392c2680a4c10", phrase: "被干", name: { zh: "被干", en: "被干" } }, { id: "adult-gray-traffic-f94bc7b4d7f3dba4", phrase: "逼奸", name: { zh: "逼奸", en: "逼奸" } }, { id: "adult-gray-traffic-e022f76878eb87e8", phrase: "仓井空", name: { zh: "仓井空", en: "仓井空" } }, { id: "adult-gray-traffic-adcd0b57f23f7a21", phrase: "插暴", name: { zh: "插暴", en: "插暴" } }, { id: "adult-gray-traffic-c72549ca90843152", phrase: "操逼", name: { zh: "操逼", en: "操逼" } }, { id: "adult-gray-traffic-2f504a7ac4a6ce7b", phrase: "操黑", name: { zh: "操黑", en: "操黑" } }, { id: "adult-gray-traffic-5436d35ba5d6fc07", phrase: "操烂", name: { zh: "操烂", en: "操烂" } }, { id: "adult-gray-traffic-4a8d56542c6b0fba", phrase: "肏你", name: { zh: "肏你", en: "肏你" } }, { id: "adult-gray-traffic-12e787a3b057c229", phrase: "肏死", name: { zh: "肏死", en: "肏死" } }, { id: "adult-gray-traffic-68c2efa2af765235", phrase: "操死", name: { zh: "操死", en: "操死" } }, { id: "adult-gray-traffic-7b2fede091f61a1f", phrase: "操我", name: { zh: "操我", en: "操我" } }, { id: "adult-gray-traffic-008bb2f808f55639", phrase: "厕奴", name: { zh: "厕奴", en: "厕奴" } }, { id: "adult-gray-traffic-62bc55020526b126", phrase: "插比", name: { zh: "插比", en: "插比" } }, { id: "adult-gray-traffic-6e7435f9d9fb0e6d", phrase: "插b", name: { zh: "插b", en: "插b" } }, { id: "adult-gray-traffic-887201d916239607", phrase: "插逼", name: { zh: "插逼", en: "插逼" } }, { id: "adult-gray-traffic-ac3e7fc27b39c09e", phrase: "插进", name: { zh: "插进", en: "插进" } }, { id: "adult-gray-traffic-eff78bd693be3785", phrase: "插我", name: { zh: "插我", en: "插我" } }, { id: "adult-gray-traffic-9f359c492b3ca813", phrase: "插阴", name: { zh: "插阴", en: "插阴" } }, { id: "adult-gray-traffic-45f7909012010ac9", phrase: "潮吹", name: { zh: "潮吹", en: "潮吹" } }, { id: "adult-gray-traffic-b572a2fa5f9d1283", phrase: "潮喷", name: { zh: "潮喷", en: "潮喷" } }, { id: "adult-gray-traffic-50f312c22af2071d", phrase: "成人dv", name: { zh: "成人dv", en: "成人dv" } }, { id: "adult-gray-traffic-6bfdb080ef89b817", phrase: "成人论坛", name: { zh: "成人论坛", en: "成人论坛" } }, { id: "adult-gray-traffic-d1cf4075ecb06ed8", phrase: "成人电", name: { zh: "成人电", en: "成人电" } }, { id: "adult-gray-traffic-4e24e038dcfee4ed", phrase: "成人卡通", name: { zh: "成人卡通", en: "成人卡通" } }, { id: "adult-gray-traffic-6e3372a624a54c03", phrase: "成人聊", name: { zh: "成人聊", en: "成人聊" } }, { id: "adult-gray-traffic-3d9441239d82b22d", phrase: "成人视", name: { zh: "成人视", en: "成人视" } }, { id: "adult-gray-traffic-7085daf43ea69bb3", phrase: "成人图", name: { zh: "成人图", en: "成人图" } }, { id: "adult-gray-traffic-45bb2f55f96e93a0", phrase: "成人文", name: { zh: "成人文", en: "成人文" } }, { id: "adult-gray-traffic-c272625720beec90", phrase: "成人小", name: { zh: "成人小", en: "成人小" } }, { id: "adult-gray-traffic-0528922ba417cc28", phrase: "成人色情", name: { zh: "成人色情", en: "成人色情" } }, { id: "adult-gray-traffic-c8e66c847d0628ac", phrase: "成人网站", name: { zh: "成人网站", en: "成人网站" } }, { id: "adult-gray-traffic-b25d4a37661d1ec2", phrase: "艳情小说", name: { zh: "艳情小说", en: "艳情小说" } }, { id: "adult-gray-traffic-2b371dfdf391e1f2", phrase: "成人游戏", name: { zh: "成人游戏", en: "成人游戏" } }, { id: "adult-gray-traffic-2e326ec05161bb01", phrase: "吃精", name: { zh: "吃精", en: "吃精" } }, { id: "adult-gray-traffic-72453fea93a7c582", phrase: "赤裸", name: { zh: "赤裸", en: "赤裸" } }, { id: "adult-gray-traffic-34ab2dfab8a4225c", phrase: "抽插", name: { zh: "抽插", en: "抽插" } }, { id: "adult-gray-traffic-2d2a6214ec4ab57f", phrase: "扌由插", name: { zh: "扌由插", en: "扌由插" } }, { id: "adult-gray-traffic-277c12f52dbab5d4", phrase: "抽一插", name: { zh: "抽一插", en: "抽一插" } }, { id: "adult-gray-traffic-b30ba82cd7f05aef", phrase: "大波", name: { zh: "大波", en: "大波" } }, { id: "adult-gray-traffic-741ccfbca571c2f5", phrase: "大力抽送", name: { zh: "大力抽送", en: "大力抽送" } }, { id: "adult-gray-traffic-170eaf413b2d641c", phrase: "大乳", name: { zh: "大乳", en: "大乳" } }, { id: "adult-gray-traffic-583b7d69cce6ce15", phrase: "荡妇", name: { zh: "荡妇", en: "荡妇" } }, { id: "adult-gray-traffic-e8fdc19497197724", phrase: "荡女", name: { zh: "荡女", en: "荡女" } }, { id: "adult-gray-traffic-8f823640128dab30", phrase: "盗撮", name: { zh: "盗撮", en: "盗撮" } }, { id: "adult-gray-traffic-e0e52aa6541b4fc2", phrase: "多人轮", name: { zh: "多人轮", en: "多人轮" } }, { id: "adult-gray-traffic-754917300a5eb3ba", phrase: "发浪", name: { zh: "发浪", en: "发浪" } }, { id: "adult-gray-traffic-79669ac63f32b9a9", phrase: "放尿", name: { zh: "放尿", en: "放尿" } }, { id: "adult-gray-traffic-7bbb76d32b144ee9", phrase: "肥逼", name: { zh: "肥逼", en: "肥逼" } }, { id: "adult-gray-traffic-0759d18300803dcf", phrase: "粉穴", name: { zh: "粉穴", en: "粉穴" } }, { id: "adult-gray-traffic-04432d0eb5699bab", phrase: "封面女郎", name: { zh: "封面女郎", en: "封面女郎" } }, { id: "adult-gray-traffic-b7c9081af0872e1d", phrase: "风月大陆", name: { zh: "风月大陆", en: "风月大陆" } }, { id: "adult-gray-traffic-ff32c58fa09e4b28", phrase: "干死你", name: { zh: "干死你", en: "干死你" } }, { id: "adult-gray-traffic-37b08ea822f0e3a7", phrase: "干穴", name: { zh: "干穴", en: "干穴" } }, { id: "adult-gray-traffic-0a291ce4b79ee76e", phrase: "龟头", name: { zh: "龟头", en: "龟头" } }, { id: "adult-gray-traffic-d555bfdf72037c09", phrase: "裹本", name: { zh: "裹本", en: "裹本" } }, { id: "adult-gray-traffic-798ba71b932685c7", phrase: "国产av", name: { zh: "国产av", en: "国产av" } }, { id: "adult-gray-traffic-c74f0538c72a56ac", phrase: "好嫩", name: { zh: "好嫩", en: "好嫩" } }, { id: "adult-gray-traffic-0db0710d878d47b2", phrase: "豪乳", name: { zh: "豪乳", en: "豪乳" } }, { id: "adult-gray-traffic-fbe3dfd656909331", phrase: "黑逼", name: { zh: "黑逼", en: "黑逼" } }, { id: "adult-gray-traffic-1415a2a845f3c0da", phrase: "后庭", name: { zh: "后庭", en: "后庭" } }, { id: "adult-gray-traffic-25420e3d8d141e2b", phrase: "后穴", name: { zh: "后穴", en: "后穴" } }, { id: "adult-gray-traffic-fe288fd9e0b72656", phrase: "花花公子", name: { zh: "花花公子", en: "花花公子" } }, { id: "adult-gray-traffic-0221eea13d1be931", phrase: "换妻俱乐部", name: { zh: "换妻俱乐部", en: "换妻俱乐部" } }, { id: "adult-gray-traffic-188219ab6457eb39", phrase: "黄片", name: { zh: "黄片", en: "黄片" } }, { id: "adult-gray-traffic-266908737763773c", phrase: "几吧", name: { zh: "几吧", en: "几吧" } }, { id: "adult-gray-traffic-cd1576313cdb4116", phrase: "鸡奸", name: { zh: "鸡奸", en: "鸡奸" } }, { id: "adult-gray-traffic-8ec7f46009da30d0", phrase: "寂寞男", name: { zh: "寂寞男", en: "寂寞男" } }, { id: "adult-gray-traffic-891a225c09de641c", phrase: "寂寞女", name: { zh: "寂寞女", en: "寂寞女" } }, { id: "adult-gray-traffic-4c44b178586ab31c", phrase: "集体淫", name: { zh: "集体淫", en: "集体淫" } }, { id: "adult-gray-traffic-81cddbcf67e7820e", phrase: "奸情", name: { zh: "奸情", en: "奸情" } }, { id: "adult-gray-traffic-bfae4fc6d2f0051a", phrase: "叫床", name: { zh: "叫床", en: "叫床" } }, { id: "adult-gray-traffic-f5582902dc11a4dd", phrase: "脚交", name: { zh: "脚交", en: "脚交" } }, { id: "adult-gray-traffic-a9652a37e864458f", phrase: "金鳞岂是池中物", name: { zh: "金鳞岂是池中物", en: "金鳞岂是池中物" } }, { id: "adult-gray-traffic-624a9b0fa5599533", phrase: "金麟岂是池中物", name: { zh: "金麟岂是池中物", en: "金麟岂是池中物" } }, { id: "adult-gray-traffic-af45dc4f92c64c61", phrase: "精液", name: { zh: "精液", en: "精液" } }, { id: "adult-gray-traffic-00bb0b0a8bbe1e7e", phrase: "就去日", name: { zh: "就去日", en: "就去日" } }, { id: "adult-gray-traffic-27b4ed6998bb1d6b", phrase: "巨屌", name: { zh: "巨屌", en: "巨屌" } }, { id: "adult-gray-traffic-1f6557695c03075e", phrase: "菊门", name: { zh: "菊门", en: "菊门" } }, { id: "adult-gray-traffic-a21c647b1dee5cf1", phrase: "巨奶", name: { zh: "巨奶", en: "巨奶" } }, { id: "adult-gray-traffic-15539ce91f0c4b67", phrase: "巨乳", name: { zh: "巨乳", en: "巨乳" } }, { id: "adult-gray-traffic-d95a6cc76ba7e362", phrase: "菊穴", name: { zh: "菊穴", en: "菊穴" } }, { id: "adult-gray-traffic-c88be49f76d0ddd6", phrase: "开苞", name: { zh: "开苞", en: "开苞" } }, { id: "adult-gray-traffic-1f29ce5c7db01948", phrase: "口爆", name: { zh: "口爆", en: "口爆" } }, { id: "adult-gray-traffic-40ca1f0660259f33", phrase: "口活", name: { zh: "口活", en: "口活" } }, { id: "adult-gray-traffic-b9d165b9df5059e4", phrase: "口射", name: { zh: "口射", en: "口射" } }, { id: "adult-gray-traffic-9b078abb0d1c5e1d", phrase: "口淫", name: { zh: "口淫", en: "口淫" } }, { id: "adult-gray-traffic-de77de17348b14f1", phrase: "裤袜", name: { zh: "裤袜", en: "裤袜" } }, { id: "adult-gray-traffic-7108af60e0d7e070", phrase: "狂操", name: { zh: "狂操", en: "狂操" } }, { id: "adult-gray-traffic-144d8b59d96f6f0e", phrase: "狂插", name: { zh: "狂插", en: "狂插" } }, { id: "adult-gray-traffic-51c9e69e88e7ab6d", phrase: "浪逼", name: { zh: "浪逼", en: "浪逼" } }, { id: "adult-gray-traffic-d877e8c703f3d47d", phrase: "浪妇", name: { zh: "浪妇", en: "浪妇" } }, { id: "adult-gray-traffic-f38dd8153e3bd6ca", phrase: "浪叫", name: { zh: "浪叫", en: "浪叫" } }, { id: "adult-gray-traffic-3b4a142f700dc10f", phrase: "浪女", name: { zh: "浪女", en: "浪女" } }, { id: "adult-gray-traffic-901280f72f76ffd1", phrase: "狼友", name: { zh: "狼友", en: "狼友" } }, { id: "adult-gray-traffic-8bc25c97fbcd658a", phrase: "聊性", name: { zh: "聊性", en: "聊性" } }, { id: "adult-gray-traffic-58d8aeedd03daf36", phrase: "流淫", name: { zh: "流淫", en: "流淫" } }, { id: "adult-gray-traffic-feec065620bd6438", phrase: "铃木麻", name: { zh: "铃木麻", en: "铃木麻" } }, { id: "adult-gray-traffic-dfdb6153dcfd2040", phrase: "凌辱", name: { zh: "凌辱", en: "凌辱" } }, { id: "adult-gray-traffic-0636106313f6b624", phrase: "漏乳", name: { zh: "漏乳", en: "漏乳" } }, { id: "adult-gray-traffic-c29abc26771d5d40", phrase: "露b", name: { zh: "露b", en: "露b" } }, { id: "adult-gray-traffic-fe832d0782692284", phrase: "轮暴", name: { zh: "轮暴", en: "轮暴" } }, { id: "adult-gray-traffic-a152fff1c9b38878", phrase: "轮操", name: { zh: "轮操", en: "轮操" } }, { id: "adult-gray-traffic-e85a464a00d26af0", phrase: "裸陪", name: { zh: "裸陪", en: "裸陪" } }, { id: "adult-gray-traffic-cdfdf26a09e5945a", phrase: "买春", name: { zh: "买春", en: "买春" } }, { id: "adult-gray-traffic-6153e566f5e31939", phrase: "美逼", name: { zh: "美逼", en: "美逼" } }, { id: "adult-gray-traffic-d781124166205977", phrase: "美少妇", name: { zh: "美少妇", en: "美少妇" } }, { id: "adult-gray-traffic-9c88e8da3cb9e6f2", phrase: "美乳", name: { zh: "美乳", en: "美乳" } }, { id: "adult-gray-traffic-cb0e8546fc6f4784", phrase: "美腿", name: { zh: "美腿", en: "美腿" } }, { id: "adult-gray-traffic-3f60f2cd0dcb0e21", phrase: "美穴", name: { zh: "美穴", en: "美穴" } }, { id: "adult-gray-traffic-2a64634ebdce8732", phrase: "美幼", name: { zh: "美幼", en: "美幼" } }, { id: "adult-gray-traffic-601be8146c58f8ab", phrase: "秘唇", name: { zh: "秘唇", en: "秘唇" } }, { id: "adult-gray-traffic-7a9c63e85222586c", phrase: "密穴", name: { zh: "密穴", en: "密穴" } }, { id: "adult-gray-traffic-08e4a20ec0bdf3cb", phrase: "蜜穴", name: { zh: "蜜穴", en: "蜜穴" } }, { id: "adult-gray-traffic-46982c4755be1836", phrase: "蜜液", name: { zh: "蜜液", en: "蜜液" } }, { id: "adult-gray-traffic-11702415691e00db", phrase: "摸奶", name: { zh: "摸奶", en: "摸奶" } }, { id: "adult-gray-traffic-43bb47516edd58be", phrase: "摸胸", name: { zh: "摸胸", en: "摸胸" } }, { id: "adult-gray-traffic-0e650a4a0f7d888a", phrase: "母奸", name: { zh: "母奸", en: "母奸" } }, { id: "adult-gray-traffic-8d61a1b16fe719b9", phrase: "奈美", name: { zh: "奈美", en: "奈美" } }, { id: "adult-gray-traffic-b4ba95e846fafea8", phrase: "男奴", name: { zh: "男奴", en: "男奴" } }, { id: "adult-gray-traffic-f810641ae3b132e4", phrase: "内射", name: { zh: "内射", en: "内射" } }, { id: "adult-gray-traffic-dc3875aa27488ed4", phrase: "嫩逼", name: { zh: "嫩逼", en: "嫩逼" } }, { id: "adult-gray-traffic-2da622d0e258986b", phrase: "嫩女", name: { zh: "嫩女", en: "嫩女" } }, { id: "adult-gray-traffic-deacd7d79094326c", phrase: "嫩穴", name: { zh: "嫩穴", en: "嫩穴" } }, { id: "adult-gray-traffic-28299f2ad04d4763", phrase: "捏弄", name: { zh: "捏弄", en: "捏弄" } }, { id: "adult-gray-traffic-540afe3609975c6d", phrase: "女优", name: { zh: "女优", en: "女优" } }, { id: "adult-gray-traffic-dc4156e0b24de172", phrase: "炮友", name: { zh: "炮友", en: "炮友" } }, { id: "adult-gray-traffic-9f74b49c6e2ebfa1", phrase: "砲友", name: { zh: "砲友", en: "砲友" } }, { id: "adult-gray-traffic-a5f1bddc24f52ec5", phrase: "喷精", name: { zh: "喷精", en: "喷精" } }, { id: "adult-gray-traffic-d25d3ac64c911dfc", phrase: "屁眼", name: { zh: "屁眼", en: "屁眼" } }, { id: "adult-gray-traffic-b943ef7a595abd2b", phrase: "品香堂", name: { zh: "品香堂", en: "品香堂" } }, { id: "adult-gray-traffic-45ce8abf119efdde", phrase: "前凸后翘", name: { zh: "前凸后翘", en: "前凸后翘" } }, { id: "adult-gray-traffic-7e7495156b9348cc", phrase: "强jian", name: { zh: "强jian", en: "强jian" } }, { id: "adult-gray-traffic-3329afbd938ed72f", phrase: "强暴", name: { zh: "强暴", en: "强暴" } }, { id: "adult-gray-traffic-dfd9eb3bfaec110b", phrase: "强奸处女", name: { zh: "强奸处女", en: "强奸处女" } }, { id: "adult-gray-traffic-68601149fd6194a0", phrase: "情趣用品", name: { zh: "情趣用品", en: "情趣用品" } }, { id: "adult-gray-traffic-9e8d01bd770d3615", phrase: "拳交", name: { zh: "拳交", en: "拳交" } }, { id: "adult-gray-traffic-f45fb61cd8db3b65", phrase: "全裸", name: { zh: "全裸", en: "全裸" } }, { id: "adult-gray-traffic-c2fc297d1b282985", phrase: "群交", name: { zh: "群交", en: "群交" } }, { id: "adult-gray-traffic-c393e18d0d1c80f8", phrase: "惹火身材", name: { zh: "惹火身材", en: "惹火身材" } }, { id: "adult-gray-traffic-e84145404ef941e5", phrase: "人妻", name: { zh: "人妻", en: "人妻" } }, { id: "adult-gray-traffic-7672078e77e8bfad", phrase: "人兽", name: { zh: "人兽", en: "人兽" } }, { id: "adult-gray-traffic-ffefbb79a9182686", phrase: "日逼", name: { zh: "日逼", en: "日逼" } }, { id: "adult-gray-traffic-7ce5df638cf21871", phrase: "日烂", name: { zh: "日烂", en: "日烂" } }, { id: "adult-gray-traffic-7ccbbbcc51f03c49", phrase: "肉棒", name: { zh: "肉棒", en: "肉棒" } }, { id: "adult-gray-traffic-dfc065a9e6bd6531", phrase: "肉逼", name: { zh: "肉逼", en: "肉逼" } }, { id: "adult-gray-traffic-9af77c08923e71fb", phrase: "肉唇", name: { zh: "肉唇", en: "肉唇" } }, { id: "adult-gray-traffic-02f926585623f475", phrase: "肉洞", name: { zh: "肉洞", en: "肉洞" } }, { id: "adult-gray-traffic-f327d778882dd557", phrase: "肉棍", name: { zh: "肉棍", en: "肉棍" } }, { id: "adult-gray-traffic-ea24aff20e301c52", phrase: "肉茎", name: { zh: "肉茎", en: "肉茎" } }, { id: "adult-gray-traffic-ecea8205f2671984", phrase: "肉具", name: { zh: "肉具", en: "肉具" } }, { id: "adult-gray-traffic-4d3364035509a50b", phrase: "揉乳", name: { zh: "揉乳", en: "揉乳" } }, { id: "adult-gray-traffic-23e231b1a9f437e2", phrase: "肉穴", name: { zh: "肉穴", en: "肉穴" } }, { id: "adult-gray-traffic-e53d41896d4a6891", phrase: "肉欲", name: { zh: "肉欲", en: "肉欲" } }, { id: "adult-gray-traffic-8ee82f50dfae627d", phrase: "乳爆", name: { zh: "乳爆", en: "乳爆" } }, { id: "adult-gray-traffic-baac231fd4d244c5", phrase: "三级片", name: { zh: "三级片", en: "三级片" } }, { id: "adult-gray-traffic-3d1d5303fdb64eb4", phrase: "骚逼", name: { zh: "骚逼", en: "骚逼" } }, { id: "adult-gray-traffic-7688eea3ceb1f3c3", phrase: "骚比", name: { zh: "骚比", en: "骚比" } }, { id: "adult-gray-traffic-dcc5abfa6dd25896", phrase: "骚水", name: { zh: "骚水", en: "骚水" } }, { id: "adult-gray-traffic-683c868904f7bf49", phrase: "骚穴", name: { zh: "骚穴", en: "骚穴" } }, { id: "adult-gray-traffic-530e90d1b92d6018", phrase: "色逼", name: { zh: "色逼", en: "色逼" } }, { id: "adult-gray-traffic-c8f740816d4f2ff7", phrase: "色界", name: { zh: "色界", en: "色界" } }, { id: "adult-gray-traffic-cecaba163705943a", phrase: "色猫", name: { zh: "色猫", en: "色猫" } }, { id: "adult-gray-traffic-74a6e2ba64a0b325", phrase: "色盟", name: { zh: "色盟", en: "色盟" } }, { id: "adult-gray-traffic-12b10746656988af", phrase: "色情网站", name: { zh: "色情网站", en: "色情网站" } }, { id: "adult-gray-traffic-11048cdbf9d70603", phrase: "色区", name: { zh: "色区", en: "色区" } }, { id: "adult-gray-traffic-0d6aeca9bdf5241a", phrase: "色欲", name: { zh: "色欲", en: "色欲" } }, { id: "adult-gray-traffic-c1a24307fdd3335b", phrase: "色b", name: { zh: "色b", en: "色b" } }, { id: "adult-gray-traffic-e481028c4fb20aba", phrase: "少年阿宾", name: { zh: "少年阿宾", en: "少年阿宾" } }, { id: "adult-gray-traffic-12f694afb6fcdab5", phrase: "少修正", name: { zh: "少修正", en: "少修正" } }, { id: "adult-gray-traffic-08755450f0ae7935", phrase: "射爽", name: { zh: "射爽", en: "射爽" } }, { id: "adult-gray-traffic-aad363f9acdfdc37", phrase: "射颜", name: { zh: "射颜", en: "射颜" } }, { id: "adult-gray-traffic-53ff912845da5f76", phrase: "食精", name: { zh: "食精", en: "食精" } }, { id: "adult-gray-traffic-a6b4fb6a84d1f42c", phrase: "释欲", name: { zh: "释欲", en: "释欲" } }, { id: "adult-gray-traffic-94a0911b834f2087", phrase: "兽奸", name: { zh: "兽奸", en: "兽奸" } }, { id: "adult-gray-traffic-8c29b68da747950d", phrase: "手淫", name: { zh: "手淫", en: "手淫" } }, { id: "adult-gray-traffic-33574dce83b23e3e", phrase: "兽欲", name: { zh: "兽欲", en: "兽欲" } }, { id: "adult-gray-traffic-0788104b7af70d4f", phrase: "熟妇", name: { zh: "熟妇", en: "熟妇" } }, { id: "adult-gray-traffic-177426ddfd4d23f6", phrase: "熟母", name: { zh: "熟母", en: "熟母" } }, { id: "adult-gray-traffic-88b780faf973e9f0", phrase: "爽片", name: { zh: "爽片", en: "爽片" } }, { id: "adult-gray-traffic-f8c4e2f848d3e431", phrase: "双臀", name: { zh: "双臀", en: "双臀" } }, { id: "adult-gray-traffic-f7531269cc2a0036", phrase: "死逼", name: { zh: "死逼", en: "死逼" } }, { id: "adult-gray-traffic-b8e25cfd2e3fa336", phrase: "丝诱", name: { zh: "丝诱", en: "丝诱" } }, { id: "adult-gray-traffic-6543b48831cf2f8b", phrase: "松岛枫", name: { zh: "松岛枫", en: "松岛枫" } }, { id: "adult-gray-traffic-8757472d4e67f068", phrase: "酥痒", name: { zh: "酥痒", en: "酥痒" } }, { id: "adult-gray-traffic-9d9a5de705ae8bf4", phrase: "汤加丽", name: { zh: "汤加丽", en: "汤加丽" } }, { id: "adult-gray-traffic-e55027e0047fdd88", phrase: "套弄", name: { zh: "套弄", en: "套弄" } }, { id: "adult-gray-traffic-450098560762f5de", phrase: "体奸", name: { zh: "体奸", en: "体奸" } }, { id: "adult-gray-traffic-eaf79e41621e12f1", phrase: "体位", name: { zh: "体位", en: "体位" } }, { id: "adult-gray-traffic-337c934caf19e43a", phrase: "舔脚", name: { zh: "舔脚", en: "舔脚" } }, { id: "adult-gray-traffic-b478adebbc525e73", phrase: "舔阴", name: { zh: "舔阴", en: "舔阴" } }, { id: "adult-gray-traffic-db8dfc5dfafaa5d7", phrase: "偷欢", name: { zh: "偷欢", en: "偷欢" } }, { id: "adult-gray-traffic-2b04070d17b9edc8", phrase: "脱内裤", name: { zh: "脱内裤", en: "脱内裤" } }, { id: "adult-gray-traffic-42813962301983bd", phrase: "我就色", name: { zh: "我就色", en: "我就色" } }, { id: "adult-gray-traffic-8201acde93b9416d", phrase: "舞女", name: { zh: "舞女", en: "舞女" } }, { id: "adult-gray-traffic-f37f9a78815f25ef", phrase: "无修正", name: { zh: "无修正", en: "无修正" } }, { id: "adult-gray-traffic-b7ddc3c485169681", phrase: "夏川纯", name: { zh: "夏川纯", en: "夏川纯" } }, { id: "adult-gray-traffic-2586dec2a8527b47", phrase: "相奸", name: { zh: "相奸", en: "相奸" } }, { id: "adult-gray-traffic-d05e151a8435442e", phrase: "小逼", name: { zh: "小逼", en: "小逼" } }, { id: "adult-gray-traffic-27eeffda0986d20b", phrase: "校鸡", name: { zh: "校鸡", en: "校鸡" } }, { id: "adult-gray-traffic-abb020790b2ce513", phrase: "小穴", name: { zh: "小穴", en: "小穴" } }, { id: "adult-gray-traffic-4090e1d0487465c6", phrase: "小xue", name: { zh: "小xue", en: "小xue" } }, { id: "adult-gray-traffic-9c3250ff63e15e91", phrase: "写真", name: { zh: "写真", en: "写真" } }, { id: "adult-gray-traffic-fe19186b28750ac5", phrase: "性感妖娆", name: { zh: "性感妖娆", en: "性感妖娆" } }, { id: "adult-gray-traffic-d913b57f4bb64a03", phrase: "性感诱惑", name: { zh: "性感诱惑", en: "性感诱惑" } }, { id: "adult-gray-traffic-ff546a4adee5c01d", phrase: "性虎", name: { zh: "性虎", en: "性虎" } }, { id: "adult-gray-traffic-decbe82fa7daaad6", phrase: "性饥渴", name: { zh: "性饥渴", en: "性饥渴" } }, { id: "adult-gray-traffic-4fac1e08165d65bf", phrase: "性技巧", name: { zh: "性技巧", en: "性技巧" } }, { id: "adult-gray-traffic-f03f9d0a0409d198", phrase: "性奴", name: { zh: "性奴", en: "性奴" } }, { id: "adult-gray-traffic-e2380db69206bc2a", phrase: "性虐", name: { zh: "性虐", en: "性虐" } }, { id: "adult-gray-traffic-30f6273388621e60", phrase: "胸推", name: { zh: "胸推", en: "胸推" } }, { id: "adult-gray-traffic-ef6df4b479e98c89", phrase: "穴口", name: { zh: "穴口", en: "穴口" } }, { id: "adult-gray-traffic-75b7be6f7ea6e165", phrase: "学生妹", name: { zh: "学生妹", en: "学生妹" } }, { id: "adult-gray-traffic-d969ce928151f1e1", phrase: "穴图", name: { zh: "穴图", en: "穴图" } }, { id: "adult-gray-traffic-84149b75775944bc", phrase: "亚情", name: { zh: "亚情", en: "亚情" } }, { id: "adult-gray-traffic-fcd208dc0b4aab8f", phrase: "杨思敏", name: { zh: "杨思敏", en: "杨思敏" } }, { id: "adult-gray-traffic-299a5792ab8c9a8f", phrase: "要射了", name: { zh: "要射了", en: "要射了" } }, { id: "adult-gray-traffic-fdceb99b4cf4eeff", phrase: "夜勤病栋", name: { zh: "夜勤病栋", en: "夜勤病栋" } }, { id: "adult-gray-traffic-b4d7212d455126d4", phrase: "一本道", name: { zh: "一本道", en: "一本道" } }, { id: "adult-gray-traffic-3ae7884e4e65efd2", phrase: "一夜欢", name: { zh: "一夜欢", en: "一夜欢" } }, { id: "adult-gray-traffic-66e9e41c48cf907c", phrase: "一ye情", name: { zh: "一ye情", en: "一ye情" } }, { id: "adult-gray-traffic-310aff0f98be15a4", phrase: "淫电影", name: { zh: "淫电影", en: "淫电影" } }, { id: "adult-gray-traffic-621628ee869a105b", phrase: "阴阜", name: { zh: "阴阜", en: "阴阜" } }, { id: "adult-gray-traffic-9c0c3260329e5655", phrase: "淫河", name: { zh: "淫河", en: "淫河" } }, { id: "adult-gray-traffic-78d6c980e4966207", phrase: "阴核", name: { zh: "阴核", en: "阴核" } }, { id: "adult-gray-traffic-b14534df24d849f0", phrase: "阴户", name: { zh: "阴户", en: "阴户" } }, { id: "adult-gray-traffic-55d675a8258ea3d3", phrase: "淫贱", name: { zh: "淫贱", en: "淫贱" } }, { id: "adult-gray-traffic-4b5912f4325a61f2", phrase: "淫叫", name: { zh: "淫叫", en: "淫叫" } }, { id: "adult-gray-traffic-36c6423579403713", phrase: "淫教师", name: { zh: "淫教师", en: "淫教师" } }, { id: "adult-gray-traffic-f3c4b21ecaff74bb", phrase: "阴精", name: { zh: "阴精", en: "阴精" } }, { id: "adult-gray-traffic-323ff639c0fda478", phrase: "淫媚", name: { zh: "淫媚", en: "淫媚" } }, { id: "adult-gray-traffic-b44a6cff03417983", phrase: "淫虐", name: { zh: "淫虐", en: "淫虐" } }, { id: "adult-gray-traffic-7f3556d969c0b73a", phrase: "淫声浪语", name: { zh: "淫声浪语", en: "淫声浪语" } }, { id: "adult-gray-traffic-802f5b437061a33e", phrase: "淫兽学园", name: { zh: "淫兽学园", en: "淫兽学园" } }, { id: "adult-gray-traffic-37dcf0e7644c407a", phrase: "淫书", name: { zh: "淫书", en: "淫书" } }, { id: "adult-gray-traffic-c21adeac66b61b38", phrase: "淫术炼金士", name: { zh: "淫术炼金士", en: "淫术炼金士" } }, { id: "adult-gray-traffic-a663cdd20ae8f52b", phrase: "淫威", name: { zh: "淫威", en: "淫威" } }, { id: "adult-gray-traffic-ed8f3fbbbd2ea9df", phrase: "淫亵", name: { zh: "淫亵", en: "淫亵" } }, { id: "adult-gray-traffic-ad2583605d97f73e", phrase: "淫样", name: { zh: "淫样", en: "淫样" } }, { id: "adult-gray-traffic-8dc31c938f5addcc", phrase: "阴b", name: { zh: "阴b", en: "阴b" } }, { id: "adult-gray-traffic-8188b39000be02e6", phrase: "应召", name: { zh: "应召", en: "应召" } }, { id: "adult-gray-traffic-b09b8df3a65f6cbb", phrase: "幼男", name: { zh: "幼男", en: "幼男" } }, { id: "adult-gray-traffic-1be3f7c6580b02f4", phrase: "欲火", name: { zh: "欲火", en: "欲火" } }, { id: "adult-gray-traffic-e73bfe135e4ca193", phrase: "欲女", name: { zh: "欲女", en: "欲女" } }, { id: "adult-gray-traffic-ffc608500d67ece5", phrase: "玉女心经", name: { zh: "玉女心经", en: "玉女心经" } }, { id: "adult-gray-traffic-0dc6a9000e5c8c89", phrase: "玉蒲团", name: { zh: "玉蒲团", en: "玉蒲团" } }, { id: "adult-gray-traffic-a0ed8b37f130c559", phrase: "玉乳", name: { zh: "玉乳", en: "玉乳" } }, { id: "adult-gray-traffic-ddab70edef45aeeb", phrase: "欲仙欲死", name: { zh: "欲仙欲死", en: "欲仙欲死" } }, { id: "adult-gray-traffic-f0aef763e3f78f5a", phrase: "玉穴", name: { zh: "玉穴", en: "玉穴" } }, { id: "adult-gray-traffic-a8a3eddad1a728c6", phrase: "原味内衣", name: { zh: "原味内衣", en: "原味内衣" } }, { id: "adult-gray-traffic-0aae1919a5ee8f90", phrase: "援助交际", name: { zh: "援助交际", en: "援助交际" } }, { id: "adult-gray-traffic-521a8033bf0b2965", phrase: "张筱雨", name: { zh: "张筱雨", en: "张筱雨" } }, { id: "adult-gray-traffic-d2ea82e00b91c5b4", phrase: "招鸡", name: { zh: "招鸡", en: "招鸡" } }, { id: "adult-gray-traffic-ce6b37624d6fad62", phrase: "招妓", name: { zh: "招妓", en: "招妓" } }, { id: "adult-gray-traffic-a011e098465c70c9", phrase: "中年美妇", name: { zh: "中年美妇", en: "中年美妇" } }, { id: "adult-gray-traffic-e1de4fa6010905c7", phrase: "抓胸", name: { zh: "抓胸", en: "抓胸" } }, { id: "adult-gray-traffic-2ae6536f8eb235bb", phrase: "自拍", name: { zh: "自拍", en: "自拍" } }, { id: "adult-gray-traffic-2e2fcf30cf5745bc", phrase: "18禁", name: { zh: "18禁", en: "18禁" } }, { id: "adult-gray-traffic-3cd723d887aa7f5c", phrase: "99bb", name: { zh: "99bb", en: "99bb" } }, { id: "adult-gray-traffic-03f67ead556e84e7", phrase: "a4y", name: { zh: "a4y", en: "a4y" } }, { id: "adult-gray-traffic-7fdc3e8038e87ff5", phrase: "adult", name: { zh: "adult", en: "adult" } }, { id: "adult-gray-traffic-8dd9ed10798ded82", phrase: "amateur", name: { zh: "amateur", en: "amateur" } }, { id: "adult-gray-traffic-2334ab3172ae72cb", phrase: "a片", name: { zh: "a片", en: "a片" } }, { id: "adult-gray-traffic-47c21198ebe6a08b", phrase: "gay片", name: { zh: "gay片", en: "gay片" } }, { id: "adult-gray-traffic-53e6707035b1f483", phrase: "g点", name: { zh: "g点", en: "g点" } }, { id: "adult-gray-traffic-0130e2d27102a651", phrase: "g片", name: { zh: "g片", en: "g片" } }, { id: "adult-gray-traffic-08775183b0ecf9d8", phrase: "hardcore", name: { zh: "hardcore", en: "hardcore" } }, { id: "adult-gray-traffic-e9bf04c34750999d", phrase: "h动画", name: { zh: "h动画", en: "h动画" } }, { id: "adult-gray-traffic-cebd9d37be016798", phrase: "h动漫", name: { zh: "h动漫", en: "h动漫" } }, { id: "adult-gray-traffic-dd32831e9d5f3da3", phrase: "incest", name: { zh: "incest", en: "incest" } }, { id: "adult-gray-traffic-3c35e97df40e46f0", phrase: "secom", name: { zh: "secom", en: "secom" } }, { id: "adult-gray-traffic-b33d985503886e36", phrase: "sexinsex", name: { zh: "sexinsex", en: "sexinsex" } }, { id: "adult-gray-traffic-97aee0ee16be7f76", phrase: "sm女王", name: { zh: "sm女王", en: "sm女王" } }, { id: "adult-gray-traffic-58c2e555821225d3", phrase: "xiao77", name: { zh: "xiao77", en: "xiao77" } }, { id: "adult-gray-traffic-5eb9eaeaff2fc872", phrase: "xing伴侣", name: { zh: "xing伴侣", en: "xing伴侣" } }, { id: "adult-gray-traffic-820e04bc0fb39434", phrase: "tokyohot", name: { zh: "tokyohot", en: "tokyohot" } }, { id: "adult-gray-traffic-4fabf6ea56b56d42", phrase: "yin荡", name: { zh: "yin荡", en: "yin荡" } }, { id: "adult-gray-traffic-40d8e4db065dd3d5", phrase: "男公关", name: { zh: "男公关", en: "男公关" } }, { id: "adult-gray-traffic-fcd669779a4250c7", phrase: "火辣", name: { zh: "火辣", en: "火辣" } }, { id: "adult-gray-traffic-65aa864b49421410", phrase: "精子", name: { zh: "精子", en: "精子" } }, { id: "adult-gray-traffic-1ad7becf1a8f7dfc", phrase: "射精", name: { zh: "射精", en: "射精" } }, { id: "adult-gray-traffic-4ce6419d1eda0c08", phrase: "诱奸", name: { zh: "诱奸", en: "诱奸" } }, { id: "adult-gray-traffic-6b753637846bed88", phrase: "发生关系", name: { zh: "发生关系", en: "发生关系" } }, { id: "adult-gray-traffic-6f424b45cca85a7f", phrase: "快感", name: { zh: "快感", en: "快感" } }, { id: "adult-gray-traffic-eea4eb329dcf5044", phrase: "猛男", name: { zh: "猛男", en: "猛男" } }, { id: "adult-gray-traffic-712eededffeca7fe", phrase: "下体", name: { zh: "下体", en: "下体" } }, { id: "adult-gray-traffic-c3a5bd4a55c71836", phrase: "浑圆", name: { zh: "浑圆", en: "浑圆" } }, { id: "adult-gray-traffic-0bfada45ac64d5ad", phrase: "发情", name: { zh: "发情", en: "发情" } }, { id: "adult-gray-traffic-011a9d5c7fd2a248", phrase: "白嫩", name: { zh: "白嫩", en: "白嫩" } }, { id: "adult-gray-traffic-f3f8cf9e41eb4d89", phrase: "粉嫩", name: { zh: "粉嫩", en: "粉嫩" } }, { id: "adult-gray-traffic-f6be5f0991c095ba", phrase: "兽性", name: { zh: "兽性", en: "兽性" } }, { id: "adult-gray-traffic-1bbeb7fbbb565008", phrase: "风骚", name: { zh: "风骚", en: "风骚" } }, { id: "adult-gray-traffic-67d163c409b7614a", phrase: "呻吟", name: { zh: "呻吟", en: "呻吟" } }, { id: "adult-gray-traffic-3cc114b23cde6734", phrase: "阉割", name: { zh: "阉割", en: "阉割" } }, { id: "adult-gray-traffic-538002c38aeb598d", phrase: "裸露", name: { zh: "裸露", en: "裸露" } }, { id: "adult-gray-traffic-3ac4373310014eeb", phrase: "不穿", name: { zh: "不穿", en: "不穿" } }, { id: "adult-gray-traffic-e72700a70a0e388d", phrase: "一丝不挂", name: { zh: "一丝不挂", en: "一丝不挂" } }, { id: "adult-gray-traffic-418010303ffa9987", phrase: "脱光", name: { zh: "脱光", en: "脱光" } }, { id: "adult-gray-traffic-f87413e217d7f657", phrase: "我干", name: { zh: "我干", en: "我干" } }, { id: "adult-gray-traffic-be6afb673317b8d6", phrase: "裙中性运动", name: { zh: "裙中性运动", en: "裙中性运动" } }, { id: "adult-gray-traffic-c15ab5059b44dbb1", phrase: "乱奸", name: { zh: "乱奸", en: "乱奸" } }, { id: "adult-gray-traffic-ed4d747a4b67fff9", phrase: "乱伦类", name: { zh: "乱伦类", en: "乱伦类" } }, { id: "adult-gray-traffic-c1443f3d55ff2852", phrase: "乱伦小", name: { zh: "乱伦小", en: "乱伦小" } }, { id: "adult-gray-traffic-58d42fda7ea878b6", phrase: "伦理大", name: { zh: "伦理大", en: "伦理大" } }, { id: "adult-gray-traffic-1dcf780e561061f5", phrase: "伦理电影", name: { zh: "伦理电影", en: "伦理电影" } }, { id: "adult-gray-traffic-0c49424ff197fdee", phrase: "伦理毛", name: { zh: "伦理毛", en: "伦理毛" } }, { id: "adult-gray-traffic-fa1bf95784cdd257", phrase: "伦理片", name: { zh: "伦理片", en: "伦理片" } }, { id: "adult-gray-traffic-8352a31539b16840", phrase: "裸聊网", name: { zh: "裸聊网", en: "裸聊网" } }, { id: "adult-gray-traffic-196c9ff119ab39f4", phrase: "裸体写真", name: { zh: "裸体写真", en: "裸体写真" } }, { id: "adult-gray-traffic-4932012163e406a4", phrase: "裸舞视", name: { zh: "裸舞视", en: "裸舞视" } }, { id: "adult-gray-traffic-74f1ede585f42966", phrase: "美女裸体", name: { zh: "美女裸体", en: "美女裸体" } }, { id: "adult-gray-traffic-0354100d9bc9bb9f", phrase: "美女写真", name: { zh: "美女写真", en: "美女写真" } }, { id: "adult-gray-traffic-6563c0711501b759", phrase: "美女上门", name: { zh: "美女上门", en: "美女上门" } }, { id: "adult-gray-traffic-2216b282be971418", phrase: "美艳少妇", name: { zh: "美艳少妇", en: "美艳少妇" } }, { id: "adult-gray-traffic-4c6a09f389d33cd3", phrase: "妹按摩", name: { zh: "妹按摩", en: "妹按摩" } }, { id: "adult-gray-traffic-b41bb87cbaa0e718", phrase: "妹上门", name: { zh: "妹上门", en: "妹上门" } }, { id: "adult-gray-traffic-ebd0de8527b1bd87", phrase: "骚妇", name: { zh: "骚妇", en: "骚妇" } }, { id: "adult-gray-traffic-a8b0aabaa0562b5d", phrase: "骚货", name: { zh: "骚货", en: "骚货" } }, { id: "adult-gray-traffic-3da44e277868b99a", phrase: "骚浪", name: { zh: "骚浪", en: "骚浪" } }, { id: "adult-gray-traffic-de8b1dc3206b0029", phrase: "骚嘴", name: { zh: "骚嘴", en: "骚嘴" } }, { id: "adult-gray-traffic-19b5c3ccb1558602", phrase: "色电影", name: { zh: "色电影", en: "色电影" } }, { id: "adult-gray-traffic-be6ba9c89136469d", phrase: "色妹妹", name: { zh: "色妹妹", en: "色妹妹" } }, { id: "adult-gray-traffic-4fcc8387584b9938", phrase: "色情表演", name: { zh: "色情表演", en: "色情表演" } }, { id: "adult-gray-traffic-b092c0a3d6b16e96", phrase: "色情电影", name: { zh: "色情电影", en: "色情电影" } }, { id: "adult-gray-traffic-2dd058fe0d6bf5f8", phrase: "色情服务", name: { zh: "色情服务", en: "色情服务" } }, { id: "adult-gray-traffic-b0c20dd76c58ff4f", phrase: "色情图片", name: { zh: "色情图片", en: "色情图片" } }, { id: "adult-gray-traffic-fc6e53a4b1e1cbd1", phrase: "色情小说", name: { zh: "色情小说", en: "色情小说" } }, { id: "adult-gray-traffic-34a5362c5d6d5678", phrase: "色情影片", name: { zh: "色情影片", en: "色情影片" } }, { id: "adult-gray-traffic-d640d34151499df5", phrase: "色情片", name: { zh: "色情片", en: "色情片" } }, { id: "adult-gray-traffic-4ff6758a2adb91ae", phrase: "色视频", name: { zh: "色视频", en: "色视频" } }, { id: "adult-gray-traffic-fd1d34ba88b702aa", phrase: "色小说", name: { zh: "色小说", en: "色小说" } }, { id: "adult-gray-traffic-c3dd4126b01c1dd2", phrase: "性福情", name: { zh: "性福情", en: "性福情" } }, { id: "adult-gray-traffic-b21adecc1329dc73", phrase: "性感少", name: { zh: "性感少", en: "性感少" } }, { id: "adult-gray-traffic-c0e40c00b11b66f2", phrase: "性伙伴", name: { zh: "性伙伴", en: "性伙伴" } }, { id: "adult-gray-traffic-1df367a953e98b1f", phrase: "性交视频", name: { zh: "性交视频", en: "性交视频" } }, { id: "adult-gray-traffic-d1e201bde07cf068", phrase: "性奴集中营", name: { zh: "性奴集中营", en: "性奴集中营" } }, { id: "adult-gray-traffic-968fbdc472483e0f", phrase: "阴蒂", name: { zh: "阴蒂", en: "阴蒂" } }, { id: "adult-gray-traffic-a11ab1e61d58c44f", phrase: "阴茎增大", name: { zh: "阴茎增大", en: "阴茎增大" } }, { id: "adult-gray-traffic-fd4be01f8b2b878d", phrase: "阴茎助勃", name: { zh: "阴茎助勃", en: "阴茎助勃" } }, { id: "adult-gray-traffic-c2962ead1e8866d5", phrase: "阴毛", name: { zh: "阴毛", en: "阴毛" } }, { id: "adult-gray-traffic-c5dbe192e43737de", phrase: "陰唇", name: { zh: "陰唇", en: "陰唇" } }, { id: "adult-gray-traffic-a6002cabdb5e68b2", phrase: "陰道", name: { zh: "陰道", en: "陰道" } }, { id: "adult-gray-traffic-788549cedac2118a", phrase: "陰戶", name: { zh: "陰戶", en: "陰戶" } }, { id: "adult-gray-traffic-b15b8f59fdb5a30f", phrase: "淫荡美女", name: { zh: "淫荡美女", en: "淫荡美女" } }, { id: "adult-gray-traffic-179b5b88406f6c19", phrase: "淫荡视频", name: { zh: "淫荡视频", en: "淫荡视频" } }, { id: "adult-gray-traffic-3028c0f52df28f32", phrase: "淫荡照片", name: { zh: "淫荡照片", en: "淫荡照片" } }, { id: "adult-gray-traffic-7366280ede30c2c1", phrase: "淫靡", name: { zh: "淫靡", en: "淫靡" } }, { id: "adult-gray-traffic-e4e094cf07f010f6", phrase: "淫魔舞", name: { zh: "淫魔舞", en: "淫魔舞" } }, { id: "adult-gray-traffic-7f685ead0ce0bc4f", phrase: "淫情女", name: { zh: "淫情女", en: "淫情女" } }, { id: "adult-gray-traffic-18ff053fe6fa6652", phrase: "淫騷妹", name: { zh: "淫騷妹", en: "淫騷妹" } }, { id: "adult-gray-traffic-906a0b70cbfadc1c", phrase: "淫兽学", name: { zh: "淫兽学", en: "淫兽学" } }, { id: "adult-gray-traffic-b2a3c03d1e0e7769", phrase: "淫穴", name: { zh: "淫穴", en: "淫穴" } }, { id: "adult-gray-traffic-623ec191106f4672", phrase: "爱女人", name: { zh: "爱女人", en: "爱女人" } }, { id: "adult-gray-traffic-219af6c42926a728", phrase: "爱液", name: { zh: "爱液", en: "爱液" } }, { id: "adult-gray-traffic-99003c9c9a19db00", phrase: "奶子", name: { zh: "奶子", en: "奶子" } }] }, { id: "scam_phishing", name: { zh: "投资 / 带单诈骗", en: "Investment scams" }, description: { zh: "保本、高收益、荐股、内幕消息等诱导话术", en: "Guaranteed-return and insider-tip lures" }, source_refs: ["cn_financial_regulator_2025", "csrc_ai_investment_2026", "ftc_crypto_2026"], rules: [{ id: "scam-guaranteed-profit", phrase: "稳赚不赔", name: { zh: "稳赚不赔", en: "稳赚不赔" } }, { id: "scam-principal-high-interest", phrase: "保本高息", name: { zh: "保本高息", en: "保本高息" } }, { id: "scam-principal-interest-guaranteed", phrase: "保本保息", name: { zh: "保本保息", en: "保本保息" } }, { id: "scam-high-return-no-risk", phrase: "高收益无风险", name: { zh: "高收益无风险", en: "高收益无风险" } }, { id: "scam-high-rebate", phrase: "高额返利", name: { zh: "高额返利", en: "高额返利" } }, { id: "scam-insider-tip", phrase: "内幕消息", name: { zh: "内幕消息", en: "内幕消息" } }, { id: "scam-expert-guarantee", phrase: "专家保证", name: { zh: "专家保证", en: "专家保证" } }, { id: "scam-teacher-signal", phrase: "老师带单", name: { zh: "老师带单", en: "老师带单" } }, { id: "scam-daily-return-three-percent", phrase: "日收益3%", name: { zh: "日收益3%", en: "日收益3%" } }, { id: "scam-stable-high-return", phrase: "稳定高收益", name: { zh: "稳定高收益", en: "稳定高收益" } }, { id: "scam-low-risk-high-return", phrase: "低风险高收益", name: { zh: "低风险高收益", en: "低风险高收益" } }, { id: "scam-risk-free-return", phrase: "无风险收益", name: { zh: "无风险收益", en: "无风险收益" } }, { id: "scam-guaranteed-principal-safe", phrase: "保证本金安全", name: { zh: "保证本金安全", en: "保证本金安全" } }, { id: "scam-never-lose-money", phrase: "绝对不会亏损", name: { zh: "绝对不会亏损", en: "绝对不会亏损" } }, { id: "scam-inside-stock-tip", phrase: "内部荐股", name: { zh: "内部荐股", en: "内部荐股" } }, { id: "scam-free-stock-tip", phrase: "免费荐股", name: { zh: "免费荐股", en: "免费荐股" } }, { id: "scam-follow-teacher-earn", phrase: "跟着老师赚钱", name: { zh: "跟着老师赚钱", en: "跟着老师赚钱" } }, { id: "scam-vip-investment-group", phrase: "VIP投资群", name: { zh: "VIP投资群", en: "VIP投资群" } }, { id: "scam-exclusive-investment-channel", phrase: "独家投资渠道", name: { zh: "独家投资渠道", en: "独家投资渠道" } }, { id: "scam-bull-stock-insider-tip", phrase: "牛股内幕消息", name: { zh: "牛股内幕消息", en: "牛股内幕消息" } }, { id: "scam-terms-teacher-signal", phrase: "老师 + 带单", name: { zh: "老师 + 带单", en: "老师 + 带单" }, terms: ["老师", "带单"], max_gap: 14 }, { id: "scam-terms-insider-tip", phrase: "内幕 + 消息", name: { zh: "内幕 + 消息", en: "内幕 + 消息" }, terms: ["内幕", "消息"], max_gap: 10 }, { id: "scam-terms-guaranteed-profit", phrase: "稳赚 + 不赔", name: { zh: "稳赚 + 不赔", en: "稳赚 + 不赔" }, terms: ["稳赚", "不赔"], max_gap: 10 }, { id: "scam-terms-principal-interest", phrase: "保本 + 高息", name: { zh: "保本 + 高息", en: "保本 + 高息" }, terms: ["保本", "高息"], max_gap: 12 }, { id: "scam-terms-high-return-risk-free", phrase: "高收益 + 无风险", name: { zh: "高收益 + 无风险", en: "高收益 + 无风险" }, terms: ["高收益", "无风险"], max_gap: 16 }, { id: "scam-terms-free-stock-tip", phrase: "免费 + 荐股", name: { zh: "免费 + 荐股", en: "免费 + 荐股" }, terms: ["免费", "荐股"], max_gap: 14 }, { id: "scam-terms-group-stock-tip", phrase: "加群 + 荐股", name: { zh: "加群 + 荐股", en: "加群 + 荐股" }, terms: ["加群", "荐股"], max_gap: 16 }, { id: "scam-terms-follow-earn", phrase: "跟单 + 赚钱", name: { zh: "跟单 + 赚钱", en: "跟单 + 赚钱" }, terms: ["跟单", "赚钱"], max_gap: 16 }] }, { id: "crypto_scam", name: { zh: "加密货币骗局", en: "Crypto scams" }, description: { zh: "空投、免费领取、双倍返还和保证收益话术", en: "Airdrop, giveaway, doubling, and guaranteed-return lures" }, source_refs: ["cn_financial_regulator_2025", "ftc_crypto_2026"], rules: [{ id: "crypto-usdt-airdrop", phrase: "USDT空投", name: { zh: "USDT空投", en: "USDT空投" } }, { id: "crypto-free-usdt", phrase: "免费领取USDT", name: { zh: "免费领取USDT", en: "免费领取USDT" } }, { id: "crypto-free-airdrop-claim", phrase: "免费领取空投", name: { zh: "免费领取空投", en: "免费领取空投" } }, { id: "crypto-airdrop-candy", phrase: "空投糖果", name: { zh: "空投糖果", en: "空投糖果" } }, { id: "crypto-price-only-rises", phrase: "币值只涨不跌", name: { zh: "币值只涨不跌", en: "币值只涨不跌" } }, { id: "crypto-claim-your-airdrop", phrase: "claim your airdrop", name: { zh: "claim your airdrop", en: "claim your airdrop" } }, { id: "crypto-free-usdt-en", phrase: "free usdt", name: { zh: "free usdt", en: "free usdt" } }, { id: "crypto-usdt-giveaway", phrase: "usdt giveaway", name: { zh: "usdt giveaway", en: "usdt giveaway" } }, { id: "crypto-send-usdt-get", phrase: "send usdt get", name: { zh: "send usdt get", en: "send usdt get" } }, { id: "crypto-double-your-crypto", phrase: "double your crypto", name: { zh: "double your crypto", en: "double your crypto" } }, { id: "crypto-double-your-bitcoin", phrase: "double your bitcoin", name: { zh: "double your bitcoin", en: "double your bitcoin" } }, { id: "crypto-claim-free-crypto", phrase: "claim free crypto", name: { zh: "claim free crypto", en: "claim free crypto" } }, { id: "crypto-guaranteed-returns", phrase: "guaranteed crypto returns", name: { zh: "guaranteed crypto returns", en: "guaranteed crypto returns" } }, { id: "crypto-web3-airdrop-benefits", phrase: "web3空投福利", name: { zh: "web3空投福利", en: "web3空投福利" } }, { id: "crypto-wallet-airdrop-claim", phrase: "钱包空投领取", name: { zh: "钱包空投领取", en: "钱包空投领取" } }, { id: "crypto-onchain-airdrop-claim", phrase: "链上空投领取", name: { zh: "链上空投领取", en: "链上空投领取" } }, { id: "crypto-airdrop-reward-claim", phrase: "领取空投奖励", name: { zh: "领取空投奖励", en: "领取空投奖励" } }, { id: "crypto-signup-usdt", phrase: "注册领取USDT", name: { zh: "注册领取USDT", en: "注册领取USDT" } }, { id: "crypto-terms-free-usdt", phrase: "免费 + 领取 + USDT", name: { zh: "免费 + 领取 + USDT", en: "免费 + 领取 + USDT" }, terms: ["免费", "领取", "USDT"], max_gap: 14 }, { id: "crypto-terms-wallet-airdrop", phrase: "钱包 + 空投", name: { zh: "钱包 + 空投", en: "钱包 + 空投" }, terms: ["钱包", "空投"], max_gap: 16 }, { id: "crypto-terms-onchain-airdrop", phrase: "链上 + 空投", name: { zh: "链上 + 空投", en: "链上 + 空投" }, terms: ["链上", "空投"], max_gap: 16 }, { id: "crypto-terms-signup-usdt", phrase: "注册 + USDT", name: { zh: "注册 + USDT", en: "注册 + USDT" }, terms: ["注册", "USDT"], max_gap: 16 }, { id: "crypto-terms-send-double", phrase: "发送 + 双倍返还", name: { zh: "发送 + 双倍返还", en: "发送 + 双倍返还" }, terms: ["发送", "双倍返还"], max_gap: 18 }, { id: "crypto-terms-connect-airdrop", phrase: "连接钱包 + 领取空投", name: { zh: "连接钱包 + 领取空投", en: "连接钱包 + 领取空投" }, terms: ["连接钱包", "领取空投"], max_gap: 18 }] }, { id: "task_job_scam", name: { zh: "兼职刷单 / 任务诈骗", en: "Task and job scams" }, description: { zh: "刷单、点赞返佣、垫资任务和求职收费话术", en: "Fake task, commission, and paid-job lures" }, source_refs: ["cac_brushing_scams_2019", "ftc_task_scams_2024", "shanghai_police_job_scams_2026"], rules: [{ id: "task-brushing-rebate", phrase: "刷单返利", name: { zh: "刷单返利", en: "刷单返利" } }, { id: "task-part-time-brushing", phrase: "兼职刷单", name: { zh: "兼职刷单", en: "兼职刷单" } }, { id: "task-like-earn-commission", phrase: "点赞赚佣金", name: { zh: "点赞赚佣金", en: "点赞赚佣金" } }, { id: "task-like-rebate", phrase: "点赞返佣", name: { zh: "点赞返佣", en: "点赞返佣" } }, { id: "task-product-optimization", phrase: "商品优化任务", name: { zh: "商品优化任务", en: "商品优化任务" } }, { id: "task-data-optimization", phrase: "数据优化任务", name: { zh: "数据优化任务", en: "数据优化任务" } }, { id: "task-task-commission", phrase: "任务返佣", name: { zh: "任务返佣", en: "任务返佣" } }, { id: "task-advance-funds", phrase: "垫付资金做任务", name: { zh: "垫付资金做任务", en: "垫付资金做任务" } }, { id: "task-top-up-unlock", phrase: "充值解锁任务", name: { zh: "充值解锁任务", en: "充值解锁任务" } }, { id: "task-combo-task", phrase: "连单任务", name: { zh: "连单任务", en: "连单任务" } }, { id: "task-frozen-order-unlock", phrase: "卡单需要解冻", name: { zh: "卡单需要解冻", en: "卡单需要解冻" } }, { id: "task-training-fee", phrase: "先交培训费", name: { zh: "先交培训费", en: "先交培训费" } }, { id: "task-high-pay-job-guarantee", phrase: "高薪包就业", name: { zh: "高薪包就业", en: "高薪包就业" } }, { id: "task-daily-paid-job", phrase: "工资日结", name: { zh: "工资日结", en: "工资日结" } }, { id: "task-daily-high-pay", phrase: "日结高薪", name: { zh: "日结高薪", en: "日结高薪" } }, { id: "task-no-experience-daily-pay", phrase: "无需经验日结", name: { zh: "无需经验日结", en: "无需经验日结" } }, { id: "task-recruit-brushing", phrase: "招聘兼职刷单", name: { zh: "招聘兼职刷单", en: "招聘兼职刷单" } }, { id: "task-complete-for-commission", phrase: "做任务领佣金", name: { zh: "做任务领佣金", en: "做任务领佣金" } }, { id: "task-terms-like-commission", phrase: "点赞 + 返佣", name: { zh: "点赞 + 返佣", en: "点赞 + 返佣" }, terms: ["点赞", "返佣"], max_gap: 14 }, { id: "task-terms-task-commission", phrase: "任务 + 佣金", name: { zh: "任务 + 佣金", en: "任务 + 佣金" }, terms: ["任务", "佣金"], max_gap: 16 }, { id: "task-terms-topup-unlock", phrase: "充值 + 解锁任务", name: { zh: "充值 + 解锁任务", en: "充值 + 解锁任务" }, terms: ["充值", "解锁任务"], max_gap: 18 }, { id: "task-terms-advance-task", phrase: "垫付 + 任务", name: { zh: "垫付 + 任务", en: "垫付 + 任务" }, terms: ["垫付", "任务"], max_gap: 16 }, { id: "task-terms-daily-highpay", phrase: "日结 + 高薪", name: { zh: "日结 + 高薪", en: "日结 + 高薪" }, terms: ["日结", "高薪"], max_gap: 12 }, { id: "task-terms-parttime-brushing", phrase: "兼职 + 刷单", name: { zh: "兼职 + 刷单", en: "兼职 + 刷单" }, terms: ["兼职", "刷单"], max_gap: 16 }] }, { id: "loan_scam", name: { zh: "贷款 / 解冻诈骗", en: "Loan and freeze-fee scams" }, description: { zh: "无抵押低息、放款前收费和刷流水话术", en: "No-collateral loan and upfront-fee lures" }, source_refs: ["cn_antifraud_ten_rules_2026", "hubei_police_loan_scams_2020"], rules: [{ id: "loan-no-collateral-low-rate", phrase: "无抵押低利率", name: { zh: "无抵押低利率", en: "无抵押低利率" } }, { id: "loan-no-collateral", phrase: "无抵押贷款", name: { zh: "无抵押贷款", en: "无抵押贷款" } }, { id: "loan-no-qualification", phrase: "无需资质放款", name: { zh: "无需资质放款", en: "无需资质放款" } }, { id: "loan-low-rate-fast", phrase: "低利率放款快", name: { zh: "低利率放款快", en: "低利率放款快" } }, { id: "loan-guarantee-before-loan", phrase: "贷款前交保证金", name: { zh: "贷款前交保证金", en: "贷款前交保证金" } }, { id: "loan-membership-fee", phrase: "先交会员费", name: { zh: "先交会员费", en: "先交会员费" } }, { id: "loan-unfreeze-fee", phrase: "先交解冻费", name: { zh: "先交解冻费", en: "先交解冻费" } }, { id: "loan-account-packaging", phrase: "包装账户流水", name: { zh: "包装账户流水", en: "包装账户流水" } }, { id: "loan-run-flow-limit", phrase: "刷流水提额度", name: { zh: "刷流水提额度", en: "刷流水提额度" } }, { id: "loan-repayment-ability", phrase: "验证还款能力", name: { zh: "验证还款能力", en: "验证还款能力" } }, { id: "loan-review-fee", phrase: "贷款审核费", name: { zh: "贷款审核费", en: "贷款审核费" } }, { id: "loan-pay-before-disbursement", phrase: "下款前交费", name: { zh: "下款前交费", en: "下款前交费" } }, { id: "loan-service-fee", phrase: "贷款收取手续费", name: { zh: "贷款收取手续费", en: "贷款收取手续费" } }, { id: "loan-account-freeze-fee", phrase: "账户冻结解冻费", name: { zh: "账户冻结解冻费", en: "账户冻结解冻费" } }, { id: "loan-tax-before-disbursement", phrase: "放款前缴税", name: { zh: "放款前缴税", en: "放款前缴税" } }, { id: "loan-agency-service", phrase: "代办贷款", name: { zh: "代办贷款", en: "代办贷款" } }, { id: "loan-fast-disbursement", phrase: "快速放款", name: { zh: "快速放款", en: "快速放款" } }, { id: "loan-instant-low-rate", phrase: "秒批低息", name: { zh: "秒批低息", en: "秒批低息" } }, { id: "loan-terms-no-collateral", phrase: "无抵押 + 放款", name: { zh: "无抵押 + 放款", en: "无抵押 + 放款" }, terms: ["无抵押", "放款"], max_gap: 16 }, { id: "loan-terms-fast-disbursement", phrase: "快速 + 放款", name: { zh: "快速 + 放款", en: "快速 + 放款" }, terms: ["快速", "放款"], max_gap: 14 }, { id: "loan-terms-fee-before", phrase: "下款前 + 交费", name: { zh: "下款前 + 交费", en: "下款前 + 交费" }, terms: ["下款前", "交费"], max_gap: 14 }, { id: "loan-terms-frozen-unfreeze", phrase: "账户冻结 + 解冻费", name: { zh: "账户冻结 + 解冻费", en: "账户冻结 + 解冻费" }, terms: ["账户冻结", "解冻费"], max_gap: 18 }, { id: "loan-terms-flow-limit", phrase: "刷流水 + 提额", name: { zh: "刷流水 + 提额", en: "刷流水 + 提额" }, terms: ["刷流水", "提额"], max_gap: 14 }] }, { id: "gambling_diversion", name: { zh: "博彩 / 赌场引流", en: "Gambling diversion" }, description: { zh: "博彩注册、送彩金和代理招募话术", en: "Casino registration, bonus, and agent lures" }, source_refs: ["community_spam_datasets"], rules: [{ id: "gambling-signup-bonus", phrase: "注册送送彩金", name: { zh: "注册送送彩金", en: "注册送送彩金" } }, { id: "gambling-signup-trial", phrase: "注册送体验金", name: { zh: "注册送体验金", en: "注册送体验金" } }, { id: "gambling-first-deposit-bonus", phrase: "首存送彩金", name: { zh: "首存送彩金", en: "首存送彩金" } }, { id: "gambling-live-casino", phrase: "真人博彩", name: { zh: "真人博彩", en: "真人博彩" } }, { id: "gambling-online-casino", phrase: "在线博彩平台", name: { zh: "在线博彩平台", en: "在线博彩平台" } }, { id: "gambling-high-cashback", phrase: "高额返现博彩", name: { zh: "高额返现博彩", en: "高额返现博彩" } }, { id: "gambling-card-bonus", phrase: "棋牌送彩金", name: { zh: "棋牌送彩金", en: "棋牌送彩金" } }, { id: "gambling-cash-agent", phrase: "现金网招代理", name: { zh: "现金网招代理", en: "现金网招代理" } }, { id: "gambling-sports-bonus", phrase: "体育投注送彩金", name: { zh: "体育投注送彩金", en: "体育投注送彩金" } }, { id: "gambling-account-registration", phrase: "博彩开户注册", name: { zh: "博彩开户注册", en: "博彩开户注册" } }, { id: "gambling-topup-customer-service", phrase: "上分下分客服", name: { zh: "上分下分客服", en: "上分下分客服" } }, { id: "gambling-one-yuan-bonus", phrase: "一元送彩金", name: { zh: "一元送彩金", en: "一元送彩金" } }, { id: "gambling-terms-signup-bonus", phrase: "注册 + 彩金", name: { zh: "注册 + 彩金", en: "注册 + 彩金" }, terms: ["注册", "彩金"], max_gap: 16 }, { id: "gambling-terms-firstdeposit-bonus", phrase: "首存 + 彩金", name: { zh: "首存 + 彩金", en: "首存 + 彩金" }, terms: ["首存", "彩金"], max_gap: 14 }, { id: "gambling-terms-casino-agent", phrase: "赌场 + 代理", name: { zh: "赌场 + 代理", en: "赌场 + 代理" }, terms: ["赌场", "代理"], max_gap: 16 }, { id: "gambling-terms-sports-bonus", phrase: "体育 + 彩金", name: { zh: "体育 + 彩金", en: "体育 + 彩金" }, terms: ["体育", "彩金"], max_gap: 16 }, { id: "gambling-terms-topup-service", phrase: "上分 + 客服", name: { zh: "上分 + 客服", en: "上分 + 客服" }, terms: ["上分", "客服"], max_gap: 16 }] }, { id: "engagement_bait", name: { zh: "互动诱导", en: "Engagement bait" }, description: { zh: "关注、点赞、转发换取奖励的话术", en: "Follow, like, and repost-for-reward phrases" }, source_refs: ["community_spam_datasets"], rules: [{ id: "engagement-follow-repost", phrase: "关注并转发", name: { zh: "关注并转发", en: "关注并转发" } }, { id: "engagement-repost-raffle", phrase: "关注转发抽奖", name: { zh: "关注转发抽奖", en: "关注转发抽奖" } }, { id: "engagement-repost-follow", phrase: "转发并关注", name: { zh: "转发并关注", en: "转发并关注" } }, { id: "engagement-follow-like-repost", phrase: "关注点赞转发", name: { zh: "关注点赞转发", en: "关注点赞转发" } }, { id: "engagement-repost-cash", phrase: "转发抽现金", name: { zh: "转发抽现金", en: "转发抽现金" } }, { id: "engagement-like-repost-raffle", phrase: "点赞转发抽奖", name: { zh: "点赞转发抽奖", en: "点赞转发抽奖" } }, { id: "engagement-follow-comment-raffle", phrase: "关注评论抽奖", name: { zh: "关注评论抽奖", en: "关注评论抽奖" } }, { id: "engagement-follow-dm-claim", phrase: "关注私信领取", name: { zh: "关注私信领取", en: "关注私信领取" } }, { id: "engagement-repost-benefit-claim", phrase: "转发领取福利", name: { zh: "转发领取福利", en: "转发领取福利" } }, { id: "engagement-follow-repost-en", phrase: "follow and repost", name: { zh: "follow and repost", en: "follow and repost" } }, { id: "engagement-repost-to-win", phrase: "repost to win", name: { zh: "repost to win", en: "repost to win" } }, { id: "engagement-like-follow-en", phrase: "like and follow", name: { zh: "like and follow", en: "like and follow" } }, { id: "engagement-retweet-to-win", phrase: "retweet to win", name: { zh: "retweet to win", en: "retweet to win" } }, { id: "engagement-terms-follow-raffle", phrase: "关注 + 抽奖", name: { zh: "关注 + 抽奖", en: "关注 + 抽奖" }, terms: ["关注", "抽奖"], max_gap: 18 }, { id: "engagement-terms-repost-cash", phrase: "转发 + 现金", name: { zh: "转发 + 现金", en: "转发 + 现金" }, terms: ["转发", "现金"], max_gap: 18 }, { id: "engagement-terms-like-reward", phrase: "点赞 + 奖励", name: { zh: "点赞 + 奖励", en: "点赞 + 奖励" }, terms: ["点赞", "奖励"], max_gap: 18 }] }, { id: "marketing_diversion", name: { zh: "通用营销引流", en: "Marketing diversion" }, description: { zh: "私信、扫码、加群、主页链接导流话术", en: "DM, QR-code, group, and profile-link lures" }, source_refs: ["community_spam_datasets"], rules: [{ id: "marketing-scan-add-wechat", phrase: "扫码加微信", name: { zh: "扫码加微信", en: "扫码加微信" } }, { id: "marketing-dm-send-link", phrase: "私信发你链接", name: { zh: "私信发你链接", en: "私信发你链接" } }, { id: "marketing-click-profile-link", phrase: "点击主页链接", name: { zh: "点击主页链接", en: "点击主页链接" } }, { id: "marketing-add-me-get-materials", phrase: "加我领取资料", name: { zh: "加我领取资料", en: "加我领取资料" } }, { id: "marketing-join-group-get-benefits", phrase: "进群领取福利", name: { zh: "进群领取福利", en: "进群领取福利" } }, { id: "marketing-dm-get-materials", phrase: "私信领取资料", name: { zh: "私信领取资料", en: "私信领取资料" } }, { id: "marketing-reply-get-materials", phrase: "回复领取资料", name: { zh: "回复领取资料", en: "回复领取资料" } }, { id: "marketing-add-wechat-get", phrase: "添加微信领取", name: { zh: "添加微信领取", en: "添加微信领取" } }, { id: "marketing-profile-link-self-service", phrase: "主页链接自取", name: { zh: "主页链接自取", en: "主页链接自取" } }, { id: "marketing-dm-get-resources", phrase: "私信获取资源", name: { zh: "私信获取资源", en: "私信获取资源" } }, { id: "marketing-scan-get-materials", phrase: "扫码领取资料", name: { zh: "扫码领取资料", en: "扫码领取资料" } }, { id: "marketing-join-group-get-materials", phrase: "加群领取资料", name: { zh: "加群领取资料", en: "加群领取资料" } }, { id: "marketing-terms-scan-wechat", phrase: "扫码 + 微信", name: { zh: "扫码 + 微信", en: "扫码 + 微信" }, terms: ["扫码", "微信"], max_gap: 16 }, { id: "marketing-terms-dm-link", phrase: "私信 + 链接", name: { zh: "私信 + 链接", en: "私信 + 链接" }, terms: ["私信", "链接"], max_gap: 18 }, { id: "marketing-terms-profile-link", phrase: "主页 + 链接", name: { zh: "主页 + 链接", en: "主页 + 链接" }, terms: ["主页", "链接"], max_gap: 18 }, { id: "marketing-terms-group-benefit", phrase: "进群 + 福利", name: { zh: "进群 + 福利", en: "进群 + 福利" }, terms: ["进群", "福利"], max_gap: 18 }, { id: "marketing-terms-add-get", phrase: "添加 + 领取", name: { zh: "添加 + 领取", en: "添加 + 领取" }, terms: ["添加", "领取"], max_gap: 18 }] }] };

  // src/keyword-packs.ts
  var DEFAULT_KEYWORD_PACK_API_BASE = "https://feedsieve-api.chendahuang.com";
  var STORAGE_KEY = "keywordPacksSnapshotV1";
  var KEYWORD_PACK_SYNC_MAX_AGE_MS = 15 * 60 * 1e3;
  var VERSION_RE2 = /^\d{4}\.\d{2}\.\d{2}\.\d{1,4}$/;
  var ID_RE = /^[a-z][a-z0-9_-]{1,95}$/;
  function localized(value) {
    return !!value && typeof value === "object" && typeof value.zh === "string" && typeof value.en === "string";
  }
  function parseKeywordPackCatalog(value) {
    if (!value || typeof value !== "object") return null;
    const raw = value;
    if (raw.schema_version !== 1 || typeof raw.pack_version !== "string" || !VERSION_RE2.test(raw.pack_version) || !Array.isArray(raw.packs))
      return null;
    const packIds = /* @__PURE__ */ new Set();
    const ruleIds = /* @__PURE__ */ new Set();
    const packs = [];
    for (const rawPack of raw.packs) {
      if (!rawPack || typeof rawPack !== "object") return null;
      const pack = rawPack;
      if (typeof pack.id !== "string" || !ID_RE.test(pack.id) || packIds.has(pack.id) || !localized(pack.name) || !localized(pack.description) || !Array.isArray(pack.source_refs) || !Array.isArray(pack.rules))
        return null;
      const sourceRefs = pack.source_refs.filter(
        (ref) => typeof ref === "string" && ref.length > 0
      );
      if (sourceRefs.length !== pack.source_refs.length) return null;
      const rules = [];
      for (const rawRule of pack.rules) {
        if (!rawRule || typeof rawRule !== "object") return null;
        const rule = rawRule;
        if (typeof rule.id !== "string" || !ID_RE.test(rule.id) || ruleIds.has(rule.id) || typeof rule.phrase !== "string" || rule.phrase.trim() !== rule.phrase || rule.phrase.length < 1 || rule.phrase.length > 80 || !localized(rule.name))
          return null;
        const rawTerms = Array.isArray(rule.terms) ? rule.terms : void 0;
        const terms = rawTerms ? rawTerms.filter(
          (term) => typeof term === "string" && term.trim() === term && term.length >= 1 && term.length <= 24
        ) : void 0;
        if (terms && (terms.length !== rawTerms.length || terms.length < 2 || terms.length > 5))
          return null;
        if (terms && (typeof rule.max_gap !== "number" || !Number.isInteger(rule.max_gap) || rule.max_gap < 0 || rule.max_gap > 32))
          return null;
        ruleIds.add(rule.id);
        rules.push({
          id: rule.id,
          phrase: rule.phrase,
          name: rule.name,
          ...terms ? { terms, max_gap: rule.max_gap } : {}
        });
      }
      if (rules.length === 0) return null;
      packIds.add(pack.id);
      packs.push({
        id: pack.id,
        name: pack.name,
        description: pack.description,
        source_refs: sourceRefs,
        rules
      });
    }
    return packs.length > 0 ? {
      schema_version: 1,
      pack_version: raw.pack_version,
      generated_at: typeof raw.generated_at === "string" ? raw.generated_at : null,
      packs
    } : null;
  }
  var BUNDLED_KEYWORD_PACK_CATALOG = (() => {
    const parsed = parseKeywordPackCatalog(official_default2);
    if (!parsed) throw new Error("invalid bundled keyword packs");
    return parsed;
  })();
  function parseManifest2(value) {
    if (!value || typeof value !== "object") return null;
    const raw = value;
    if (raw.schema_version !== 1 || typeof raw.pack_version !== "string" || !VERSION_RE2.test(raw.pack_version) || !Array.isArray(raw.files))
      return null;
    const file = raw.files.find(
      (candidate) => candidate && typeof candidate === "object" && candidate.path === "official.json"
    );
    if (!file || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(file.sha256) || typeof file.packs !== "number" || typeof file.rules !== "number")
      return null;
    return {
      schema_version: 1,
      pack_version: raw.pack_version,
      files: [
        {
          path: "official.json",
          sha256: file.sha256.toLowerCase(),
          packs: file.packs,
          rules: file.rules
        }
      ]
    };
  }
  function parseStored(value) {
    if (!value || typeof value !== "object") return null;
    const raw = value;
    return typeof raw.pack_version === "string" && typeof raw.body === "string" && typeof raw.synced_at === "number" ? { pack_version: raw.pack_version, body: raw.body, synced_at: raw.synced_at } : null;
  }
  async function getKeywordPackCatalog() {
    const stored = parseStored(await kvGet(STORAGE_KEY, null));
    if (!stored) return BUNDLED_KEYWORD_PACK_CATALOG;
    try {
      const parsed = parseKeywordPackCatalog(JSON.parse(stored.body));
      return parsed?.pack_version === stored.pack_version ? parsed : BUNDLED_KEYWORD_PACK_CATALOG;
    } catch {
      return BUNDLED_KEYWORD_PACK_CATALOG;
    }
  }
  async function sha256Hex2(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  async function syncKeywordPackCatalog(options = {}) {
    const fetchImpl = options.fetchImpl ?? gmFetch;
    const apiBaseResolved = (options.apiBase ?? "").trim() || DEFAULT_KEYWORD_PACK_API_BASE;
    const stored = parseStored(await kvGet(STORAGE_KEY, null));
    if (!options.force && stored && Date.now() - stored.synced_at < KEYWORD_PACK_SYNC_MAX_AGE_MS)
      return { status: "up_to_date", version: stored.pack_version };
    let manifestResponse;
    try {
      manifestResponse = await fetchImpl(`${apiBaseResolved}/v1/keyword-packs/latest`);
    } catch {
      return { status: "error", error: "manifest_network_error" };
    }
    if (!manifestResponse.ok)
      return { status: "error", error: `manifest_http_${manifestResponse.status}` };
    const manifest = parseManifest2(await manifestResponse.json().catch(() => null));
    if (!manifest) return { status: "error", error: "invalid_manifest" };
    if (stored?.pack_version === manifest.pack_version)
      return { status: "up_to_date", version: manifest.pack_version };
    let bodyResponse;
    try {
      bodyResponse = await fetchImpl(
        `${apiBaseResolved}/v1/keyword-packs/${manifest.pack_version}/official.json`
      );
    } catch {
      return { status: "error", error: "pack_network_error" };
    }
    if (!bodyResponse.ok) return { status: "error", error: `pack_http_${bodyResponse.status}` };
    const body = await bodyResponse.text();
    if (await sha256Hex2(body) !== manifest.files[0].sha256)
      return { status: "error", error: "checksum_mismatch" };
    let catalog = null;
    try {
      catalog = parseKeywordPackCatalog(JSON.parse(body));
    } catch {
    }
    if (!catalog || catalog.pack_version !== manifest.pack_version)
      return { status: "error", error: "invalid_pack_body" };
    const next = {
      pack_version: catalog.pack_version,
      body,
      synced_at: Date.now()
    };
    await kvSet(STORAGE_KEY, next);
    return { status: "updated", version: catalog.pack_version };
  }
  function subscribeKeywordPackCatalog(onChange) {
    return kvSubscribe(STORAGE_KEY, () => void getKeywordPackCatalog().then(onChange));
  }

  // src/keyword-rules.ts
  var STORAGE_KEY2 = "keywordRulesV1";
  var MAX_CUSTOM_KEYWORD_RULES = 80;
  var MAX_PHRASE_LENGTH = 80;
  var OFFICIAL_ID_RE = /^[a-z][a-z0-9_-]{1,95}$/;
  var SUBSCRIPTION_DEFAULTS_VERSION = 3;
  var DEFAULT_SUBSCRIBED_CATEGORY_IDS = ["adult_gray_traffic"];
  function flattenOfficialRules(catalog) {
    return catalog.packs.flatMap(
      (pack) => pack.rules.map((rule) => ({ ...rule, category: pack.id }))
    );
  }
  var OFFICIAL_KEYWORD_CATEGORIES = BUNDLED_KEYWORD_PACK_CATALOG.packs.map(({ id, name, description }) => ({
    id,
    name,
    description
  }));
  var OFFICIAL_KEYWORD_RULES = flattenOfficialRules(
    BUNDLED_KEYWORD_PACK_CATALOG
  );
  function normalizeKeywordPhrase(value) {
    return value.trim().normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").toLocaleLowerCase();
  }
  function textForMatch(value) {
    return normalizeKeywordPhrase(value).replace(/[\p{P}\p{S}\s]+/gu, "");
  }
  function orderedTermsMatch(value, terms, maxGap) {
    const haystack = textForMatch(value);
    let cursor = 0;
    for (const term of terms) {
      const needle = textForMatch(term);
      const index = haystack.indexOf(needle, cursor);
      if (index < 0) return false;
      if (cursor > 0 && index - cursor > maxGap) return false;
      cursor = index + needle.length;
    }
    return true;
  }
  function ruleMatchesText(value, rule) {
    if (rule.terms?.length) return orderedTermsMatch(value, rule.terms, rule.maxGap ?? 12);
    return textForMatch(value).includes(textForMatch(rule.phrase));
  }
  function isValidPhrase(value) {
    const phrase = value.trim();
    return phrase.length >= 1 && phrase.length <= MAX_PHRASE_LENGTH;
  }
  function normalizeSettings(value) {
    const raw = value && typeof value === "object" ? value : {};
    const disabledOfficialRuleIds = Array.isArray(raw.disabledOfficialRuleIds) ? raw.disabledOfficialRuleIds.filter(
      (id) => typeof id === "string" && OFFICIAL_ID_RE.test(id)
    ) : [];
    const hasCurrentSubscriptionDefaults = raw.subscriptionDefaultsVersion === SUBSCRIPTION_DEFAULTS_VERSION;
    const subscribedCategoryIds = hasCurrentSubscriptionDefaults ? Array.isArray(raw.subscribedCategoryIds) ? raw.subscribedCategoryIds.filter(
      (category) => typeof category === "string" && OFFICIAL_ID_RE.test(category)
    ) : [] : DEFAULT_SUBSCRIBED_CATEGORY_IDS.filter(
      (id) => BUNDLED_KEYWORD_PACK_CATALOG.packs.some((pack) => pack.id === id)
    );
    const customRules = Array.isArray(raw.customRules) ? raw.customRules.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item;
      const phrase = typeof candidate.phrase === "string" ? candidate.phrase.trim() : "";
      const id = typeof candidate.id === "string" ? candidate.id : "";
      return id && isValidPhrase(phrase) ? [{ id, phrase, createdAt: Number(candidate.createdAt) || 0 }] : [];
    }).slice(0, MAX_CUSTOM_KEYWORD_RULES) : [];
    return {
      subscriptionDefaultsVersion: SUBSCRIPTION_DEFAULTS_VERSION,
      subscribedCategoryIds: [...new Set(subscribedCategoryIds)],
      disabledOfficialRuleIds: [...new Set(disabledOfficialRuleIds)],
      customRules
    };
  }
  async function getKeywordRuleSettings() {
    return normalizeSettings(await kvGet(STORAGE_KEY2, null));
  }
  async function saveKeywordRuleSettings(settings2) {
    await kvSet(STORAGE_KEY2, settings2);
  }
  async function addCustomKeywordRule(value) {
    const phrase = value.trim();
    if (!isValidPhrase(phrase)) throw new Error("invalid_keyword_phrase");
    const settings2 = await getKeywordRuleSettings();
    const normalized = normalizeKeywordPhrase(phrase);
    if (settings2.customRules.some((rule) => normalizeKeywordPhrase(rule.phrase) === normalized))
      return settings2;
    if (settings2.customRules.length >= MAX_CUSTOM_KEYWORD_RULES) throw new Error("keyword_rule_limit");
    const next = {
      ...settings2,
      customRules: [
        ...settings2.customRules,
        { id: crypto.randomUUID(), phrase, createdAt: Date.now() }
      ]
    };
    await saveKeywordRuleSettings(next);
    return next;
  }
  async function removeCustomKeywordRule(id) {
    const settings2 = await getKeywordRuleSettings();
    const next = { ...settings2, customRules: settings2.customRules.filter((rule) => rule.id !== id) };
    await saveKeywordRuleSettings(next);
    return next;
  }
  async function setOfficialKeywordCategorySubscribed(category, subscribed) {
    const settings2 = await getKeywordRuleSettings();
    const categories = new Set(settings2.subscribedCategoryIds);
    if (subscribed) categories.add(category);
    else categories.delete(category);
    const next = { ...settings2, subscribedCategoryIds: [...categories] };
    await saveKeywordRuleSettings(next);
    return next;
  }
  function activeKeywordRules(settings2, catalog = BUNDLED_KEYWORD_PACK_CATALOG) {
    const disabled = new Set(settings2.disabledOfficialRuleIds);
    const subscribed = new Set(settings2.subscribedCategoryIds);
    return [
      ...settings2.customRules.map((rule) => ({
        id: `custom:${rule.id}`,
        source: "custom",
        phrase: rule.phrase,
        category: "other"
      })),
      ...flattenOfficialRules(catalog).filter((rule) => subscribed.has(rule.category) && !disabled.has(rule.id)).map((rule) => ({
        id: `official:${rule.id}`,
        source: "official",
        phrase: rule.phrase,
        category: rule.category,
        ...rule.terms ? { terms: rule.terms, maxGap: rule.max_gap } : {}
      }))
    ];
  }
  function createKeywordHeuristics(settings2, catalog = BUNDLED_KEYWORD_PACK_CATALOG) {
    return activeKeywordRules(settings2, catalog).map((rule) => ({
      id: `keyword:${rule.id}`,
      check(input) {
        const fields = [input.displayName, input.handle, input.text, input.bio].filter(
          (value) => typeof value === "string" && value.length > 0
        );
        if (!fields.some((field) => ruleMatchesText(field, rule))) return null;
        return rule.source === "custom" ? `命中你的关键词：${rule.phrase}` : `命中官方规则：${rule.phrase}`;
      }
    }));
  }
  function categoryForKeywordRuleId(ruleId, catalog = BUNDLED_KEYWORD_PACK_CATALOG) {
    if (!ruleId?.startsWith("keyword:official:")) return void 0;
    const officialId = ruleId.slice("keyword:official:".length);
    return flattenOfficialRules(catalog).find((rule) => rule.id === officialId)?.category;
  }
  function subscribeKeywordRules(onChange) {
    return kvSubscribe(STORAGE_KEY2, () => {
      void getKeywordRuleSettings().then(onChange);
    });
  }

  // src/policy.ts
  function classifyDetection(input) {
    const { detection, communityEntry } = input;
    if (detection.source === "blocked") return "review";
    if (detection.source === "community-list") {
      return communityEntry ? "block-candidate" : "review";
    }
    if (detection.source === "builtin-list") return "block-candidate";
    if (detection.source === "fingerprint" || detection.source === "domain") {
      return input.strength === "deep_clean" ? "review" : "ignore";
    }
    if (detection.source === "heuristic" && detection.ruleId?.startsWith("keyword:")) {
      return "review";
    }
    return "ignore";
  }
  var SELF_DOMAINS = ["x.com", "twitter.com", "t.co", "twimg.com"];
  function isSelfDomain(hostname) {
    const lower = hostname.toLowerCase();
    return SELF_DOMAINS.some((d) => lower === d || lower.endsWith(`.${d}`));
  }
  function collectLinkDomains(links) {
    const domains = [];
    for (const link of links) {
      if (!link.hostname || isSelfDomain(link.hostname)) continue;
      const hostname = link.hostname.toLowerCase();
      if (!domains.includes(hostname)) domains.push(hostname);
      if (domains.length >= 5) break;
    }
    return domains.length > 0 ? domains : void 0;
  }
  function categoryFromDetection(source, ruleId, communityCategory) {
    if (source !== "heuristic") {
      if (source === "fingerprint") return "copy_paste";
      if (source === "domain") return "scam_phishing";
      return communityCategory ?? "other";
    }
    const keywordCategory = categoryForKeywordRuleId(ruleId);
    if (keywordCategory) return keywordCategory;
    switch (ruleId) {
      case "porn-bait-zh":
        return "adult_gray_traffic";
      case "default-name-digits":
        return "bot_spam";
      case "spam-link-hint":
        return "scam_phishing";
      case "templated-text":
        return "copy_paste";
      default:
        return "other";
    }
  }
  var CATEGORY_LABELS = {
    bot_spam: "机器人",
    copy_paste: "重复刷屏",
    ai_slop: "AI 垃圾",
    advertising: "广告号",
    adult_gray_traffic: "色情引流",
    scam_phishing: "诈骗",
    engagement_bait: "互动钓鱼",
    other: "其他"
  };
  function categoryLabel(category) {
    return CATEGORY_LABELS[category] ?? category;
  }

  // src/ui.ts
  var MARK_ATTRIBUTE = "data-fs-marked";
  var HIDDEN_ATTRIBUTE = "data-fs-hidden";
  var STYLE_ELEMENT_ID = "feedsieve-mark-styles";
  var PANEL_HOST_ID = "feedsieve-panel-host";
  function ensureStyles() {
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.textContent = `
    /* 统一细黄环：outline 不占布局空间，不挤压 X 内容，也绝不隐藏推文。 */
    [${MARK_ATTRIBUTE}] {
      outline: 2px solid rgb(242 201 76 / 72%) !important;
      outline-offset: -2px;
      border-radius: 16px;
    }
    [${HIDDEN_ATTRIBUTE}] { display: none !important; }
    .fs-badge {
      display: flex;
      gap: 10px;
      align-items: center;
      padding: 3px 10px;
      margin: 2px 12px 8px;
      width: fit-content;
      max-width: calc(100% - 24px);
      border: 1px solid #f2c94c;
      border-radius: 999px;
      background: #fffbe6;
      color: #5c4d00;
      font-size: 12px;
      line-height: 1.5;
      font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .fs-reason { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fs-actions { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
    .fs-block-now {
      min-width: 34px; padding: 2px 7px;
      border: 1px solid #d4a900; border-radius: 999px;
      background: #f2c94c; color: #3d3200;
      font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap;
    }
    .fs-block-now:hover:not(:disabled) { background: #ffd950; }
    .fs-block-now:disabled { opacity: 0.6; cursor: wait; }
    .fs-allow {
      padding: 2px 8px; border: 1px solid #d9d9d9; border-radius: 999px;
      background: #fff; color: #999; font-size: 12px; cursor: pointer; white-space: nowrap;
    }
    .fs-allow:hover { border-color: #b3b3b3; color: #666; }

    /* ---------- 悬浮面板 ---------- */
    #${PANEL_HOST_ID} {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    /* 浮窗入口：渐变黄 + 多层软阴影 + 内高光，避免贴纸感；入场 280ms。
       cursor: grab + touch-action: none 让按钮本身可直接拖动定位。 */
    .fs-fab {
      position: relative;
      width: 46px; height: 46px; border-radius: 50%;
      border: 1px solid #c99600;
      background: linear-gradient(135deg, #f6d35a 0%, #e6b83a 100%);
      color: #3d3200;
      cursor: grab; padding: 0;
      touch-action: none; user-select: none; -webkit-user-select: none;
      display: inline-flex; align-items: center; justify-content: center;
      box-shadow:
        0 8px 20px rgba(0, 0, 0, 0.14),
        0 2px 6px rgba(0, 0, 0, 0.10),
        inset 0 1px 0 rgba(255, 255, 255, 0.55),
        inset 0 -1px 0 rgba(0, 0, 0, 0.06);
      transition:
        transform 200ms cubic-bezier(0.4, 0, 0.2, 1),
        box-shadow 200ms cubic-bezier(0.4, 0, 0.2, 1),
        filter 200ms cubic-bezier(0.4, 0, 0.2, 1);
      animation: fs-fab-in 280ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
    }
    .fs-fab:hover {
      transform: translateY(-1px);
      filter: brightness(1.04);
      box-shadow:
        0 12px 26px rgba(0, 0, 0, 0.18),
        0 4px 10px rgba(0, 0, 0, 0.12),
        inset 0 1px 0 rgba(255, 255, 255, 0.6),
        inset 0 -1px 0 rgba(0, 0, 0, 0.06);
    }
    .fs-fab:active {
      transform: translateY(0) scale(0.95);
      transition-duration: 90ms;
    }
    .fs-fab:focus-visible {
      outline: 2px solid rgba(60, 50, 0, 0.4);
      outline-offset: 2px;
    }
    .fs-fab svg { display: block; }
    /* 拖动中：取消 hover/active 视觉，加强阴影让按钮像被”拿起来“。 */
    .fs-fab.is-dragging,
    .fs-fab.is-dragging:hover,
    .fs-fab.is-dragging:active {
      cursor: grabbing;
      transform: none; filter: none; transition: none; animation: none;
      box-shadow:
        0 18px 36px rgba(0, 0, 0, 0.22),
        0 6px 12px rgba(0, 0, 0, 0.14),
        inset 0 1px 0 rgba(255, 255, 255, 0.6),
        inset 0 -1px 0 rgba(0, 0, 0, 0.06);
    }
    @keyframes fs-fab-in {
      from { opacity: 0; transform: scale(0.86) translateY(8px); }
      to   { opacity: 1; transform: scale(1) translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .fs-fab { animation: none; transition: none; }
    }
    .fs-panel {
      position: absolute; right: 0; bottom: 54px; width: 268px;
      background: #fff; color: #222; border: 1px solid #e2e2e2; border-radius: 12px;
      box-shadow: 0 8px 28px rgb(0 0 0 / 16%); padding: 12px; font-size: 12px;
    }
    .fs-panel h3 { margin: 0 0 8px; font-size: 13px; display: flex; justify-content: space-between; align-items: center; }
    .fs-panel .fs-close { border: 0; background: transparent; cursor: pointer; color: #999; font-size: 14px; }
    .fs-row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; }
    .fs-row .fs-k { color: #777; }
    .fs-panel select, .fs-panel button.fs-act {
      font: inherit; border-radius: 8px;
    }
    .fs-panel select { border: 1px solid #d9d9d9; padding: 2px 6px; background: #fff; }
    .fs-acts { display: flex; gap: 6px; margin-top: 8px; }
    .fs-act {
      flex: 1; padding: 6px 8px; border: 1px solid #d4a900; border-radius: 8px;
      background: #f2c94c; color: #3d3200; font-weight: 700; cursor: pointer;
    }
    .fs-act.secondary { background: #fff; border-color: #d9d9d9; color: #555; font-weight: 500; }
    .fs-act:disabled { opacity: 0.55; cursor: wait; }
    .fs-msg { margin-top: 8px; color: #8a6d00; min-height: 15px; word-break: break-all; }
    .fs-check { display: flex; align-items: center; gap: 6px; padding: 3px 0; cursor: pointer; }
    .fs-sep { height: 1px; background: #eee; margin: 8px 0 6px; }
    .fs-kw-title { display: flex; justify-content: space-between; color: #777; margin-bottom: 4px; }
    .fs-kw-list { max-height: 132px; overflow-y: auto; }
    .fs-kw-item { display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer; }
    .fs-kw-item .fs-kw-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fs-kw-item .fs-kw-n { color: #aaa; font-variant-numeric: tabular-nums; }
    .fs-kw-add { display: flex; gap: 6px; margin-top: 6px; }
    .fs-input {
      flex: 1; min-width: 0; font: inherit; padding: 5px 8px;
      border: 1px solid #d9d9d9; border-radius: 8px; background: #fff;
    }
    .fs-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .fs-chip {
      display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
      padding: 2px 6px; border: 1px solid #d9d9d9; border-radius: 999px;
      background: #fafafa; color: #555;
    }
    .fs-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fs-chip button {
      border: 0; background: transparent; color: #999; cursor: pointer; font-size: 12px;
      line-height: 1; padding: 0;
    }
    .fs-chip button:hover { color: #c00; }
    .fs-reset-link {
      background: none; border: 0; padding: 0; cursor: pointer;
      color: #999; font-size: 11px; text-decoration: underline;
    }
    .fs-reset-link:hover { color: #444; }
    .fs-api-row { flex-direction: column; align-items: stretch; gap: 4px; }
    .fs-api-input {
      width: 100%; padding: 4px 8px;
      font-size: 11px; font-family: ui-monospace, "SF Mono", Consolas, monospace;
      border: 1px solid #d9d9d9; border-radius: 6px;
    }
    .fs-api-input:focus { outline: 2px solid rgba(242, 201, 76, 0.5); outline-offset: -1px; }
  `;
    document.documentElement.appendChild(style);
  }
  function buildBadge(reason, handlers) {
    const badge = document.createElement("div");
    badge.className = "fs-badge";
    const label = document.createElement("span");
    label.className = "fs-reason";
    label.textContent = reason;
    label.title = reason;
    const actions = document.createElement("span");
    actions.className = "fs-actions";
    const blockBtn = document.createElement("button");
    blockBtn.className = "fs-block-now";
    blockBtn.type = "button";
    blockBtn.textContent = "拉黑";
    blockBtn.title = "标记垃圾账号并经页面原生接口拉黑";
    blockBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      handlers.onBlock(blockBtn);
    });
    const allowBtn = document.createElement("button");
    allowBtn.className = "fs-allow";
    allowBtn.type = "button";
    allowBtn.textContent = "误标？";
    allowBtn.title = "加入个人白名单，此后绝不再标注";
    allowBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      handlers.onAllow();
    });
    actions.append(blockBtn, allowBtn);
    badge.append(label, actions);
    return badge;
  }
  function createPanel(handlers) {
    const host = document.createElement("div");
    host.id = PANEL_HOST_ID;
    const fab = document.createElement("button");
    fab.className = "fs-fab";
    fab.type = "button";
    fab.setAttribute("aria-label", "FeedSieve 控制面板");
    fab.title = "FeedSieve 控制面板";
    fab.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16l-6 8v6l-4-2v-4z"/></svg>';
    const panel2 = document.createElement("div");
    panel2.className = "fs-panel";
    panel2.style.display = "none";
    panel2.innerHTML = `
    <h3><span>FeedSieve</span><button class="fs-close" type="button" title="收起">✕</button></h3>
    <div class="fs-row"><span class="fs-k">快照版本</span><span data-f="version">-</span></div>
    <div class="fs-row"><span class="fs-k">上次同步</span><span data-f="synced">-</span></div>
    <div class="fs-row"><span class="fs-k">本页黄框</span><span data-f="marked">0</span></div>
    <div class="fs-row"><span class="fs-k">个人白名单</span><span data-f="allowed">0</span></div>
    <div class="fs-row"><span class="fs-k">已拉黑记账</span><span data-f="blocked">0</span></div>
    <label class="fs-row"><span class="fs-k">标注强度</span>
      <select data-f="strength">
        <option value="refresh">清爽</option>
        <option value="standard">标准</option>
        <option value="deep_clean">大扫除</option>
      </select>
    </label>
    <label class="fs-check"><input type="checkbox" data-f="enabled" /> 启用社区名单</label>
    <label class="fs-row fs-api-row">
      <span class="fs-k">API 地址 <span style="color:#aaa;">(留空 = 默认)</span></span>
      <input class="fs-input fs-api-input" data-f="api-base" type="text" inputmode="url"
             autocomplete="off" spellcheck="false"
             placeholder="https://feedsieve-api.chendahuang.com" />
    </label>
    <div class="fs-sep"></div>
    <div class="fs-kw-title"><span>关键词词库</span><span data-f="kw-count"></span></div>
    <div class="fs-kw-list" data-f="kw-cats"></div>
    <div class="fs-kw-add">
      <input class="fs-input" data-f="kw-input" type="text" maxlength="80" placeholder="自定义关键词" />
      <button class="fs-act secondary" type="button" data-f="kw-add">添加</button>
    </div>
    <div class="fs-chips" data-f="kw-custom"></div>
    <div class="fs-acts">
      <button class="fs-act" type="button" data-f="block-all">一键拉黑本页</button>
      <button class="fs-act secondary" type="button" data-f="sync">同步名单</button>
    </div>
    <div class="fs-msg" data-f="msg"></div>
    <div style="text-align: right; margin-top: 4px;">
      <button type="button" class="fs-reset-link" data-f="reset-fab" title="拖动入口到任意位置后，点这里复位到默认右下角">复位入口位置</button>
    </div>
  `;
    host.append(fab, panel2);
    document.documentElement.appendChild(host);
    const $ = (field) => panel2.querySelector(`[data-f="${field}"]`);
    const closeBtn = panel2.querySelector(".fs-close");
    const strengthSel = $("strength");
    const enabledChk = $("enabled");
    const blockAllBtn = $("block-all");
    const syncBtn = $("sync");
    const kwCats = $("kw-cats");
    const kwCustom = $("kw-custom");
    const kwInput = $("kw-input");
    const kwAddBtn = $("kw-add");
    let open = false;
    const setOpen = (value) => {
      open = value;
      panel2.style.display = open ? "block" : "none";
    };
    const DRAG_THRESHOLD_PX = 4;
    let dragging = false;
    let didMove = false;
    let startPointer = { x: 0, y: 0 };
    let startHost = { left: 0, top: 0 };
    let suppressNextClick = false;
    fab.addEventListener("dragstart", (event) => event.preventDefault());
    const onPointerDown = (event) => {
      if (event.button !== void 0 && event.button !== 0 && event.pointerType === "mouse") return;
      const rect = host.getBoundingClientRect();
      startPointer = { x: event.clientX, y: event.clientY };
      startHost = { left: rect.left, top: rect.top };
      dragging = true;
      didMove = false;
      try {
        fab.setPointerCapture(event.pointerId);
      } catch {
      }
    };
    const onPointerMove = (event) => {
      if (!dragging) return;
      const dx = event.clientX - startPointer.x;
      const dy = event.clientY - startPointer.y;
      if (!didMove && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      didMove = true;
      fab.classList.add("is-dragging");
      event.preventDefault();
      const W = window.innerWidth;
      const H = window.innerHeight;
      const hostW = host.offsetWidth || 46;
      const hostH = host.offsetHeight || 46;
      const left = Math.min(Math.max(0, startHost.left + dx), Math.max(0, W - hostW));
      const top = Math.min(Math.max(0, startHost.top + dy), Math.max(0, H - hostH));
      host.style.position = "fixed";
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    };
    const onPointerUp = (event) => {
      if (!dragging) return;
      dragging = false;
      fab.classList.remove("is-dragging");
      try {
        fab.releasePointerCapture(event.pointerId);
      } catch {
      }
      if (!didMove) return;
      event.preventDefault();
      suppressNextClick = true;
      const rect = host.getBoundingClientRect();
      const W = window.innerWidth;
      const H = window.innerHeight;
      handlers.onPersistFabPosition({
        rightPct: Math.min(1, Math.max(0, rect.right / W)),
        bottomPct: Math.min(1, Math.max(0, rect.bottom / H))
      });
    };
    fab.addEventListener("pointerdown", onPointerDown);
    fab.addEventListener("pointermove", onPointerMove);
    fab.addEventListener("pointerup", onPointerUp);
    fab.addEventListener("pointercancel", onPointerUp);
    fab.addEventListener("click", (event) => {
      if (suppressNextClick) {
        event.preventDefault();
        event.stopPropagation();
        suppressNextClick = false;
        return;
      }
      setOpen(!open);
    });
    const applyFabPosition = (position) => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      const hostW = host.offsetWidth || 46;
      const hostH = host.offsetHeight || 46;
      const left = Math.max(0, Math.min(W - hostW, position.rightPct * W - hostW));
      const top = Math.max(0, Math.min(H - hostH, position.bottomPct * H - hostH));
      host.style.position = "fixed";
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    };
    const applyDefaultFabPosition = () => {
      host.style.position = "fixed";
      host.style.left = "auto";
      host.style.top = "auto";
      host.style.right = "16px";
      host.style.bottom = "16px";
    };
    closeBtn.addEventListener("click", () => setOpen(false));
    const resetFabBtn = $("reset-fab");
    resetFabBtn.addEventListener("click", () => handlers.onResetFabPosition());
    const apiBaseInput = $("api-base");
    const submitApiBase = () => {
      handlers.onApiBaseChange(apiBaseInput.value.trim());
    };
    apiBaseInput.addEventListener("change", submitApiBase);
    apiBaseInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitApiBase();
      }
    });
    strengthSel.addEventListener(
      "change",
      () => handlers.onStrengthChange(strengthSel.value)
    );
    enabledChk.addEventListener("change", () => handlers.onToggleEnabled(enabledChk.checked));
    blockAllBtn.addEventListener("click", () => handlers.onBlockAll());
    syncBtn.addEventListener("click", () => handlers.onSync());
    const submitKeyword = () => {
      const phrase = kwInput.value.trim();
      if (!phrase) return;
      kwInput.value = "";
      handlers.onAddCustomKeyword(phrase);
    };
    kwAddBtn.addEventListener("click", submitKeyword);
    kwInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitKeyword();
      }
    });
    let firstState = true;
    let lastCategorySignature = "";
    let lastCustomSignature = "";
    function renderKeywordCategories(state) {
      const signature = JSON.stringify(
        state.keywordCategories.map((c) => [c.id, c.subscribed, c.ruleCount])
      );
      if (signature === lastCategorySignature) return;
      lastCategorySignature = signature;
      kwCats.textContent = "";
      for (const category of state.keywordCategories) {
        const row = document.createElement("label");
        row.className = "fs-kw-item";
        row.title = category.label;
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = category.subscribed;
        box.addEventListener(
          "change",
          () => handlers.onToggleKeywordCategory(category.id, box.checked)
        );
        const name = document.createElement("span");
        name.className = "fs-kw-name";
        name.textContent = category.label;
        const count = document.createElement("span");
        count.className = "fs-kw-n";
        count.textContent = String(category.ruleCount);
        row.append(box, name, count);
        kwCats.appendChild(row);
      }
    }
    function renderCustomKeywords(state) {
      const signature = JSON.stringify(state.customKeywords.map((k) => [k.id, k.phrase]));
      if (signature === lastCustomSignature) return;
      lastCustomSignature = signature;
      kwCustom.textContent = "";
      for (const keyword of state.customKeywords) {
        const chip = document.createElement("span");
        chip.className = "fs-chip";
        const text = document.createElement("span");
        text.textContent = keyword.phrase;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "✕";
        remove.title = "删除该关键词";
        remove.addEventListener("click", () => handlers.onRemoveCustomKeyword(keyword.id));
        chip.append(text, remove);
        kwCustom.appendChild(chip);
      }
    }
    return {
      toggle() {
        setOpen(!open);
      },
      applyFabPosition,
      applyDefaultFabPosition,
      update(state) {
        $("version").textContent = state.version || "-";
        $("synced").textContent = state.syncedAt ? new Date(state.syncedAt).toLocaleString() : "从未";
        $("marked").textContent = String(state.markedCount);
        $("allowed").textContent = String(state.allowedCount);
        $("blocked").textContent = String(state.blockedCount);
        $("kw-count").textContent = state.activeKeywordRuleCount > 0 ? `${state.activeKeywordRuleCount} 条生效` : "未订阅";
        $("msg").textContent = state.message;
        if (firstState) {
          strengthSel.value = state.strength;
          enabledChk.checked = state.enabled;
          apiBaseInput.value = state.apiBase ?? "";
          firstState = false;
        }
        renderKeywordCategories(state);
        renderCustomKeywords(state);
        blockAllBtn.textContent = `一键拉黑本页(${state.markedCount})`;
        blockAllBtn.disabled = state.busy || state.markedCount === 0;
        syncBtn.disabled = state.busy;
        syncBtn.textContent = state.busy ? "处理中…" : "同步名单";
      }
    };
  }

  // src/main.ts
  var SCAN_DEBOUNCE_MS = 300;
  var PACE_MS = 400;
  var SYNC_INTERVAL_MS2 = 15 * 60 * 1e3;
  var BUILTIN_LIST = toHandleSet(official_default.entries);
  var pageMarked = /* @__PURE__ */ new Map();
  var scanSnapshots = /* @__PURE__ */ new WeakMap();
  var revision = 0;
  var community = null;
  var settings = { enabled: true, strength: "standard", autoContribute: true };
  var keywordCatalog = null;
  var keywordSettings = null;
  var keywordHeuristics = [];
  var allowCache = /* @__PURE__ */ new Set();
  var blockedCache = /* @__PURE__ */ new Set();
  var snapshotSyncedAt = null;
  var batchRunning = false;
  var message = "";
  var panel = null;
  var scanTimer;
  var observed = false;
  async function refreshRuntime() {
    const [runtime, nextSettings, allowlist, blocked, snapshot, nextKeywordSettings, catalog] = await Promise.all([
      buildRuntimeCommunity(),
      getCommunitySettings(),
      getAllowlist(),
      getBlockedAccounts(),
      getCommunitySnapshot(),
      getKeywordRuleSettings(),
      getKeywordPackCatalog()
    ]);
    community = runtime;
    settings = nextSettings;
    keywordSettings = nextKeywordSettings;
    keywordCatalog = catalog;
    keywordHeuristics = createKeywordHeuristics(nextKeywordSettings, catalog);
    allowCache = new Set(allowlist.map((item) => item.handle));
    blockedCache = new Set(blocked.map((item) => item.handle));
    snapshotSyncedAt = snapshot?.synced_at ?? null;
    revision += 1;
    scheduleScan();
    updatePanel();
  }
  function keywordCategoryStates() {
    const catalog = keywordCatalog;
    const settingsNow = keywordSettings;
    if (!catalog || !settingsNow) return [];
    return catalog.packs.map((pack) => ({
      id: pack.id,
      label: pack.name.zh,
      subscribed: settingsNow.subscribedCategoryIds.includes(pack.id),
      ruleCount: pack.rules.length
    }));
  }
  function customKeywordStates() {
    return (keywordSettings?.customRules ?? []).map((rule) => ({ id: rule.id, phrase: rule.phrase }));
  }
  function updatePanel() {
    panel?.update({
      version: community?.version ?? "未启用",
      enabled: settings.enabled,
      strength: settings.strength,
      markedCount: pageMarked.size,
      allowedCount: allowCache.size,
      blockedCount: blockedCache.size,
      syncedAt: snapshotSyncedAt,
      message,
      busy: batchRunning,
      keywordCategories: keywordCategoryStates(),
      activeKeywordRuleCount: keywordHeuristics.length,
      customKeywords: customKeywordStates(),
      apiBase: settings.communityApiBase ?? ""
    });
  }
  function setMessage(next) {
    message = next;
    updatePanel();
  }
  function scheduleScan() {
    if (scanTimer !== void 0) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = void 0;
      scanArticles();
    }, SCAN_DEBOUNCE_MS);
  }
  function scanArticles() {
    if (!document.body) return;
    const context = contextFromPath(location.pathname);
    for (const article of document.querySelectorAll(tweetSelectors.article)) {
      if (scanSnapshots.get(article) === revision) continue;
      scanSnapshots.set(article, revision);
      try {
        evaluate(article, context);
      } catch {
      }
    }
  }
  function evaluate(article, context) {
    const item = extractFeedItem(article, context);
    if (!item) return;
    const handle = normalizeHandle(item.author.handle);
    if (!handle) return;
    const cell = article.closest(tweetSelectors.timelineCell) ?? article;
    if (blockedCache.has(handle)) {
      pageMarked.delete(handle);
      cell.setAttribute(HIDDEN_ATTRIBUTE, "1");
      return;
    }
    if (allowCache.has(handle)) return;
    const input = {
      handle,
      displayName: item.author.displayName,
      text: item.text,
      links: item.links
    };
    const evidence = {};
    const fingerprint = contentFingerprint(input);
    if (fingerprint) evidence.contentFingerprint = fingerprint;
    const linkDomains = collectLinkDomains(item.links);
    if (linkDomains) evidence.linkDomains = linkDomains;
    const indirectEvidence = {
      ...community?.fingerprintSet.size ? { fingerprints: community.fingerprintSet } : {},
      ...community?.domainSet.size ? { domains: community.domainSet } : {}
    };
    let detection = community ? detect(input, {
      list: community.handleSet,
      listSource: "community-list",
      // v0.5 指纹即 SimHash：simhashes 与 fingerprints 同源，exact 优先、变体兜底
      ...community.fingerprintSet.size ? { simhashes: community.fingerprintSet } : {},
      ...indirectEvidence,
      // 关键词等单信号只保留在 Detector 评测层，不再直接进入用户黄框
      heuristics: []
    }) : null;
    if (!detection && BUILTIN_LIST.size > 0) {
      detection = detect(input, {
        list: BUILTIN_LIST,
        listSource: "builtin-list",
        ...indirectEvidence,
        heuristics: []
      });
    }
    if (!detection) {
      detection = detect(input, {
        ...indirectEvidence,
        // 仅运行用户明确配置的字面短语和可逐条关闭的官方词库
        heuristics: keywordHeuristics
      });
    }
    if (!detection) return;
    let communityEntry = null;
    if (detection.source === "community-list" && community) {
      communityEntry = community.index.lookup(item.author.handle) ?? null;
    }
    const presentation = classifyDetection({
      detection,
      strength: settings.strength,
      communityEntry
    });
    if (presentation === "ignore") return;
    const category = keywordCategoryForDetection(detection) ?? categoryFromDetection(detection.source, detection.ruleId, communityEntry?.category);
    const reason = displayReason(detection, communityEntry);
    markCell(cell, handle, detection, category, reason, evidence);
  }
  function keywordCategoryForDetection(detection) {
    if (detection.source !== "heuristic") return void 0;
    return categoryForKeywordRuleId(detection.ruleId, keywordCatalog ?? void 0);
  }
  function displayReason(detection, entry) {
    if (detection.source === "community-list" && entry) {
      const label = categoryLabel(entry.category);
      const votes = entry.report_count > 1 ? `${entry.report_count} 人标记` : "社区名单";
      return `${votes}为${label}`;
    }
    switch (detection.ruleId) {
      case "list":
        return "社区名单中的垃圾账号";
      case "community-fingerprint":
      case "community-fingerprint-sim":
        return "与已确认垃圾账号发布的内容高度相似";
      case "community-domain":
        return "包含社区确认的可疑链接";
      default:
        return detection.ruleId?.startsWith("keyword:") ? detection.reason.replace(/^启发式：/, "") : detection.reason;
    }
  }
  function markCell(cell, handle, detection, category, reason, evidence) {
    if (cell.querySelector(".fs-badge")) return;
    cell.setAttribute(MARK_ATTRIBUTE, detection.source);
    pageMarked.set(handle, {
      handle,
      category,
      reason,
      source: detection.source,
      ...detection.ruleId ? { ruleId: detection.ruleId } : {},
      evidence,
      cell
    });
    const badge = buildBadge(reason, {
      onBlock: (button) => {
        void runBlockNow(handle, button);
      },
      onAllow: () => {
        void allowMarked(handle);
      }
    });
    if (badge) cell.appendChild(badge);
    updatePanel();
  }
  async function blockOne(item, origin, communityVote) {
    let xUserId = await getUserId(item.handle);
    if (!xUserId) {
      xUserId = await resolveUserIdByHandle(item.handle) ?? void 0;
      if (!xUserId) return { ok: false, code: "no-id" };
      void saveUserIds([{ handle: item.handle, xUserId }]).catch(() => {
      });
    }
    const result = await runNativeAction("block", xUserId);
    if (!result.ok) return { ok: false, code: result.code };
    await markBlocked(item.handle, xUserId, {
      category: item.category,
      detectionSource: item.source,
      origin,
      ...item.evidence,
      ...typeof communityVote === "boolean" ? { communityVote } : {}
    });
    blockedCache.add(item.handle);
    return { ok: true };
  }
  function releaseMark(handle) {
    const item = pageMarked.get(handle);
    pageMarked.delete(handle);
    if (!item) return;
    item.cell.removeAttribute(MARK_ATTRIBUTE);
    item.cell.querySelector(".fs-badge")?.remove();
    item.cell.setAttribute(HIDDEN_ATTRIBUTE, "1");
  }
  async function runBlockNow(handle, button) {
    const item = pageMarked.get(handle);
    if (!item) return;
    button.disabled = true;
    button.textContent = "…";
    const result = await blockOne(item, "single-detection", settings.autoContribute);
    if (result.ok) {
      button.textContent = "✓";
      releaseMark(handle);
    } else {
      button.textContent = result.code === "no-id" ? "无ID" : "失败";
      button.title = result.code ?? "block failed";
      window.setTimeout(() => {
        button.disabled = false;
        button.textContent = "拉黑";
      }, 2500);
    }
    updatePanel();
  }
  async function allowMarked(handle) {
    const item = pageMarked.get(handle);
    await addAllowlist(handle, await getUserId(handle), {
      detectionSource: item?.source ?? "",
      ...item?.ruleId ? { ruleId: item.ruleId } : {},
      detectionReason: item?.reason ?? ""
    });
    allowCache.add(handle);
    if (item) {
      item.cell.removeAttribute(MARK_ATTRIBUTE);
      item.cell.querySelector(".fs-badge")?.remove();
    }
    pageMarked.delete(handle);
    setMessage(`已加入白名单：@${handle}`);
  }
  async function blockAllOnPage() {
    if (batchRunning) return;
    const handles = [...pageMarked.keys()];
    if (handles.length === 0) return;
    batchRunning = true;
    updatePanel();
    let ok = 0;
    let failed = 0;
    for (const handle of handles) {
      const item = pageMarked.get(handle);
      if (!item) continue;
      const result = await blockOne(item, "page-batch", settings.autoContribute);
      if (result.ok) {
        ok += 1;
        releaseMark(handle);
      } else {
        failed += 1;
      }
      setMessage(`批量拉黑：成功 ${ok}，失败 ${failed}，剩余 ${handles.length - ok - failed}`);
      updatePanel();
      await sleep(PACE_MS);
    }
    batchRunning = false;
    setMessage(`批量拉黑完成：成功 ${ok}，失败 ${failed}`);
    updatePanel();
  }
  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
  function describeSync(snapshot, packs) {
    const snapshotText = (() => {
      switch (snapshot.status) {
        case "updated":
          return `名单已更新 ${snapshot.version}`;
        case "unchanged":
          return "名单已最新";
        case "skipped":
          return "名单 6 小时内已同步";
        case "error":
          return `名单同步失败：${snapshot.error}`;
      }
    })();
    const packsText = (() => {
      switch (packs.status) {
        case "updated":
          return `词库已更新 ${packs.version}`;
        case "up_to_date":
          return "词库已最新";
        case "error":
          return `词库同步失败：${packs.error}`;
      }
    })();
    return `${snapshotText} · ${packsText}`;
  }
  async function backgroundSync(force) {
    const settings2 = await getCommunitySettings();
    const apiBase = settings2.communityApiBase;
    const [snapshot, packs] = await Promise.all([
      syncNow(force, apiBase),
      syncKeywordPackCatalog({ force, apiBase })
    ]);
    if (snapshot.status === "updated" || packs.status === "updated") {
      await refreshRuntime();
    }
    if (force) setMessage(describeSync(snapshot, packs));
  }
  function whenDomReady() {
    return new Promise((resolve) => {
      if (document.body) {
        resolve();
        return;
      }
      const observer = new MutationObserver(() => {
        if (document.body) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
    });
  }
  function observeTimeline() {
    if (observed || !document.body) return;
    observed = true;
    const observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", () => scheduleScan());
  }
  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== "function") return;
    GM_registerMenuCommand("FeedSieve：打开面板", () => panel?.toggle());
    GM_registerMenuCommand("FeedSieve：立即同步名单与词库", () => void backgroundSync(true));
    GM_registerMenuCommand("FeedSieve：一键拉黑本页黄框", () => void blockAllOnPage());
  }
  async function bootstrap() {
    ensureStyles();
    panel = createPanel({
      onSync: () => void backgroundSync(true),
      onBlockAll: () => void blockAllOnPage(),
      onStrengthChange: (strength) => {
        void setCommunitySettings({ strength }).then(() => refreshRuntime());
      },
      onToggleEnabled: (enabled) => {
        void setCommunitySettings({ enabled }).then(() => refreshRuntime());
      },
      onToggleKeywordCategory: (id, subscribed) => {
        void setOfficialKeywordCategorySubscribed(id, subscribed).then(() => refreshRuntime());
      },
      onAddCustomKeyword: (phrase) => {
        void addCustomKeywordRule(phrase).then(() => {
          setMessage(`已添加关键词：${phrase}`);
          return refreshRuntime();
        }).catch(() => setMessage("关键词无效或已达上限"));
      },
      onRemoveCustomKeyword: (id) => {
        void removeCustomKeywordRule(id).then(() => refreshRuntime());
      },
      onPersistFabPosition: (position) => {
        void setFabPosition(position);
      },
      onResetFabPosition: () => {
        void clearFabPosition().then(() => panel?.applyDefaultFabPosition());
      },
      onApiBaseChange: (apiBase) => {
        void setCommunitySettings({ communityApiBase: apiBase || void 0 }).then(() => {
          setMessage(apiBase ? `API 已切换到 ${apiBase}，同步中…` : "已恢复默认 API 地址，同步中…");
          return backgroundSync(true);
        });
      }
    });
    void getFabPosition().then((saved) => {
      if (saved) panel?.applyFabPosition(saved);
    });
    registerMenuCommands();
    subscribeCommunity(() => void refreshRuntime());
    subscribeKeywordRules(() => void refreshRuntime());
    subscribeKeywordPackCatalog(() => void backgroundSync(false));
    await refreshRuntime();
    await whenDomReady();
    observeTimeline();
    scheduleScan();
    void backgroundSync(false);
    window.setInterval(() => void backgroundSync(false), SYNC_INTERVAL_MS2);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        void backgroundSync(false);
        scheduleScan();
      }
    });
  }
  if (location.hostname === "x.com" || location.hostname === "twitter.com") {
    void bootstrap().catch(() => {
    });
  }
})();
