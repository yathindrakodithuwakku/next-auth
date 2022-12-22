import { JWTSessionError, SessionTokenError } from "../../errors.js"
import { fromDate } from "../utils/date.js"

import type { Adapter } from "../../adapters.js"
import type { InternalOptions, ResponseInternal, Session } from "../../types.js"
import type { SessionStore } from "../cookie.js"

/** Return a session object filtered via `callbacks.session` */
export async function session(
  sessionStore: SessionStore,
  options: InternalOptions
): Promise<ResponseInternal<Session | {}>> {
  const {
    adapter,
    jwt,
    events,
    callbacks,
    logger,
    session: { strategy: sessionStrategy, maxAge: sessionMaxAge },
  } = options

  const response: ResponseInternal<Session | {}> = {
    body: {},
    headers: { "Content-Type": "application/json" },
    cookies: [],
  }

  const sessionToken = sessionStore.value

  if (!sessionToken) return response

  if (sessionStrategy === "jwt") {
    try {
      const decodedToken = await jwt.decode({ ...jwt, token: sessionToken })

      const newExpires = fromDate(sessionMaxAge)

      // By default, only exposes a limited subset of information to the client
      // as needed for presentation purposes (e.g. "you are logged in as...").
      const session = {
        user: {
          name: decodedToken?.name,
          email: decodedToken?.email,
          image: decodedToken?.picture,
        },
        expires: newExpires.toISOString(),
      }

      // @ts-expect-error
      const token = await callbacks.jwt({ token: decodedToken })
      // @ts-expect-error
      const newSession = await callbacks.session({ session, token })

      // Return session payload as response
      response.body = newSession

      // Refresh JWT expiry by re-signing it, with an updated expiry date
      const newToken = await jwt.encode({
        ...jwt,
        token,
        maxAge: options.session.maxAge,
      })

      // Set cookie, to also update expiry date on cookie
      const sessionCookies = sessionStore.chunk(newToken, {
        expires: newExpires,
      })

      response.cookies?.push(...sessionCookies)

      await events.session?.({ session: newSession, token })
    } catch (error) {
      logger.error(new JWTSessionError(error))
      // If the JWT is not verifiable remove the broken session cookie(s).
      response.cookies?.push(...sessionStore.clean())
    }

    return response
  }

  // Retrieve session from database
  try {
    const { getSessionAndUser, deleteSession, updateSession } =
      adapter as Adapter
    let userAndSession = await getSessionAndUser(sessionToken)

    // If session has expired, clean up the database
    if (
      userAndSession &&
      userAndSession.session.expires.valueOf() < Date.now()
    ) {
      await deleteSession(sessionToken)
      userAndSession = null
    }

    if (userAndSession) {
      const { user, session } = userAndSession

      const sessionUpdateAge = options.session.updateAge
      // Calculate last updated date to throttle write updates to database
      // Formula: ({expiry date} - sessionMaxAge) + sessionUpdateAge
      //     e.g. ({expiry date} - 30 days) + 1 hour
      const sessionIsDueToBeUpdatedDate =
        session.expires.valueOf() -
        sessionMaxAge * 1000 +
        sessionUpdateAge * 1000

      const newExpires = fromDate(sessionMaxAge)
      // Trigger update of session expiry date and write to database, only
      // if the session was last updated more than {sessionUpdateAge} ago
      if (sessionIsDueToBeUpdatedDate <= Date.now()) {
        await updateSession({
          sessionToken: sessionToken,
          expires: newExpires,
        })
      }

      // Pass Session through to the session callback
      // @ts-expect-error
      const sessionPayload = await callbacks.session({
        // By default, only exposes a limited subset of information to the client
        // as needed for presentation purposes (e.g. "you are logged in as...").
        session: {
          user: {
            name: user.name,
            email: user.email,
            image: user.image,
          },
          expires: session.expires.toISOString(),
        },
        user,
      })

      // Return session payload as response
      response.body = sessionPayload

      // Set cookie again to update expiry
      response.cookies?.push({
        name: options.cookies.sessionToken.name,
        value: sessionToken,
        options: {
          ...options.cookies.sessionToken.options,
          expires: newExpires,
        },
      })

      // @ts-expect-error
      await events.session?.({ session: sessionPayload })
    } else if (sessionToken) {
      // If `sessionToken` was found set but it's not valid for a session then
      // remove the sessionToken cookie from browser.
      response.cookies?.push(...sessionStore.clean())
    }
  } catch (error) {
    logger.error(new SessionTokenError(error))
  }

  return response
}
