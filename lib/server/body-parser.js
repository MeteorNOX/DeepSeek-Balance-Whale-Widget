export function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0

        req.on('data', (chunk) => {
            size += chunk.length

            if (size > 8192) {
                reject(
                    new Error(
                        'body too large',
                    ),
                )

                req.destroy()

                return
            }

            chunks.push(chunk)
        })

        req.on('end', () => {
            resolve(
                Buffer.concat(
                    chunks,
                ).toString('utf8'),
            )
        })

        req.on('error', reject)
    })
}