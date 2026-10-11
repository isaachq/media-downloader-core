/**
 * Everything that can go wrong talking to TikTok, as distinct cases — so a
 * caller can tell "back off and come back later" from "this post is private"
 * from "TikTok changed its pages, use the other extractor".
 */
export type TikTokProblem =
  /** A "please wait" / verification page, a captcha or a login wall: slow down. */
  | 'challenge'
  /** 403 / 429 / an empty answer where data was expected: slow down. */
  | 'refused'
  | 'private'
  /** Deleted post or account, or a short link that leads to the home page. */
  | 'removed'
  /** The page no longer has the data where this module expects it. */
  | 'format-changed'
  /** Photo carousel without a video to download. */
  | 'photo-post'

export class TikTokError extends Error {
  override readonly name = 'TikTokError'

  constructor(
    readonly problem: TikTokProblem,
    message: string,
  ) {
    super(message)
  }

  /** Worth retrying later (after backing off). */
  get transient(): boolean {
    return this.problem === 'challenge' || this.problem === 'refused'
  }
}
