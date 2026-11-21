/**
 * A channel thread is shared: Slack threads, Teams conversations and Telegram groups keep one session for everyone in them, whose `userId` is
 * whoever opened it. Memory is recalled for and written to the author of the message being answered, so each message runs as its author (C09).
 */
export function asAuthor<S extends { userId: string }>(session: S, author: string): S {
  return session.userId === author ? session : { ...session, userId: author };
}
