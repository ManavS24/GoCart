// One JSON object per line: the log stream is the only telemetry this
// application emits, and a JSON record can be filtered and alerted on.
// Fields are always passed explicitly, so a credential cannot arrive by accident.
const emit = (level, event, fields = {}) => {
    const line = JSON.stringify({
        level,
        event,
        time: new Date().toISOString(),
        ...fields,
    })

    // Separable at the collector without parsing every line.
    if (level === 'error' || level === 'warn') console.error(line)
    else console.log(line)

    return line
}

// Ties two lines from one request together, which a per-failure id cannot.
export const requestId = (request) =>
    request?.headers?.get?.('x-vercel-id')
    || request?.headers?.get?.('x-request-id')
    || null

export const logger = {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
}

// An Error serialises to {}, so the fields worth keeping are lifted out by hand.
export const describeError = (error) => ({
    name: error?.name,
    code: error?.code,
    message: error?.message,
    stack: error?.stack,
})

export default logger
