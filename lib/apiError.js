import { NextResponse } from 'next/server'
import { describeError, logger, requestId } from '@/lib/logger'

// Logged in full, described generically: Prisma puts the database host and query
// text in `error.message`, and these handlers answer unauthenticated requests.
// The `errorId` is the only thing tying a caller's report to the log line.
export const apiError = (error, status = 500, request = null) => {
    const errorId = crypto.randomUUID()

    logger.error('api_error', {
        errorId,
        requestId: requestId(request),
        status,
        ...describeError(error),
    })

    return NextResponse.json(
        { error: 'An internal server error occurred.', errorId },
        { status }
    )
}

export default apiError
