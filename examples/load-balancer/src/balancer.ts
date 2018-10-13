/**
 * A fetch function load balancer. Distributes requests to a set of backends; attempts to
 * send requests to most recently healthy backends using a 2 random (pick two healthiest,
 * randomize which gets requests).
 *
 * If all backends are healthy, tries to evenly distribute requests as much as possible.
 *
 * When backends return server errors (500-599) it retries idempotent requests
 *  until it gets a good response, or all backends have been tried.
 *
 * @param backends fetch functions for each backend to balance accross
 * @returns a function that behaves just like fetch, with a `.backends` property for
 * retrieving backend stats.
 */

 import {
   LATENCY_DEVIATION_ALLOWED,
   AVERAGE_LATENCY_EXPECTED,
   HEALTH_SCORE_WEIGHT,
   LATENCY_SCORE_WEIGHT,
   LATENCY_SCORE_INSTABILITY_WEIGHT,
 } from '../balancer-config'

 // todo: when the load balancer loads, get old score values from a database
 // accept the old score values as a param in the balancer

export default function balancer(backends: FetchFn[]) {
  const tracked = backends.map((h) => {
    if (typeof h !== "function") {
      throw Error("Backend must be a fetch like function")
    }
    return <Backend>{
      proxy: h,
      requestCount: 0,
      scoredRequestCount: 0,
      statuses: Array<number>(10),
      latencies: Array<number>(10),
      healthScore: 1,
      latencyScore: 1,
      score: 1,
      lastError: 0,
      errorCount: 0,
    }
  })

  const fn = async function fetchBalancer(req: RequestInfo, init?: RequestInit | undefined): Promise<Response> {
    if (typeof req === "string") {
      req = new Request(req)
    }
    const attempted = new Set<Backend>()

    while (attempted.size < tracked.length) {
      const [backendA, backendB] = chooseBackends(tracked, attempted)

      if (!backendA) return new Response("No backend available", { status: 502 })

      // randomize between two to not overload
      const backend = !backendB
        ? backendA
        : (Math.floor(Math.random() * 2) == 0) ? backendA : backendB

      const promise = backend.proxy(req, init)

      // score backends for future selection
      if (backend.scoredRequestCount != backend.requestCount) score(backend)
      backend.requestCount += 1
      attempted.add(backend)

      let resp: Response
      let latency = 0
      try {
        const requestStart = new Date().getTime()
        resp = await promise
        latency = new Date().getTime() - requestStart
      } catch (e) {
        resp = proxyError
      }

      if (backend.statuses.length < 10) {
        backend.statuses.push(resp.status)
        backend.latencies.push(latency)
      } else {
        backend.statuses[(backend.requestCount - 1) % backend.statuses.length] = resp.status
        backend.latencies[(backend.requestCount - 1) % backend.latencies.length] = latency
      }

      if (resp.status >= 500 && resp.status < 600) {
        backend.lastError = Date.now()
        score(backend)
        if (canRetry(req, resp)) continue
      }

      return resp
    }

    return proxyError
  }

  return Object.assign(fn, { backends: tracked })
}

const proxyError = new Response("couldn't connect to origin", { status: 502 })

export interface FetchFn {
  (req: RequestInfo, init?: RequestInit | undefined): Promise<Response>
}

/**
 * Represents a backend with health and statistics.
 */
export interface Backend {
  proxy: (req: RequestInfo, init?: RequestInit | undefined) => Promise<Response>,
  requestCount: 0,
  scoredRequestCount: 0,
  statuses: number[],
  latencies: number[],
  lastError: number,
  healthScore: number,
  latencyScore: number,
  score: number,
  errorCount: 0
}

function score(backend: Backend, errorBasis?: number) {
  if (typeof errorBasis !== "number" && !errorBasis) errorBasis = Date.now()

  const timeSinceError = (errorBasis - backend.lastError)
  const { statuses, latencies } = backend
  const timeWeight = (backend.lastError === 0 && 0) ||
    ((timeSinceError < 1000) && 1) ||
    ((timeSinceError < 3000) && 0.8) ||
    ((timeSinceError < 5000) && 0.3) ||
    ((timeSinceError < 10000) && 0.1) ||
    0;
  const measuresTaken = latencies.filter(l => !!l).length

  if (measuresTaken < 2) return [0, 0, 0]
  let errors = statuses.reduce(
    (acc, s) => (s && !isNaN(s) && s >= 500 && s < 600) ? ++acc : acc,
    0
  )
  const healthScore = parseFloat((1 - (timeWeight * (errors / measuresTaken))).toFixed(2))

  let beyondAllowedLatencyDeviation = 0

  const LATENCY_SCORE_PING_WEIGHT = 1 - LATENCY_SCORE_INSTABILITY_WEIGHT

  // get the middle latency so as to drop the extreme ends of the spectrum
  const sortedLatencies = latencies.sort((l1, l2) => {
    if (l1 > l2) return 1
    if (l1 < l2) return -1
    return 0
  })
  const middleLatency = sortedLatencies[Math.floor(measuresTaken / 2)]
  const averageLatency = sortedLatencies.reduce(
    (acc, l) => {
      if (Math.abs(acc - l) < LATENCY_DEVIATION_ALLOWED) return (acc + l) / 2
      beyondAllowedLatencyDeviation += 1
      return acc
    },
    middleLatency
  )

  /*
  calculates how many times the value flucutates beyond the expected latency and allowed latency thresholds
  signalling instability in the backend
  */
  const correctedLatencyDeviationCount = measuresTaken > 3 ? beyondAllowedLatencyDeviation : 0
  const instabilityScore = 1 - (correctedLatencyDeviationCount / measuresTaken)
  const latencyDiscrepancy = averageLatency / AVERAGE_LATENCY_EXPECTED
  /*
  pingScore is the main latency indicator
  ranges between 0 - 1
  1 when the latency is the average expected or below it
  and lower when the latency value is higher than expected
  */
  const pingScore = latencyDiscrepancy <= 1
    ? 1
    : AVERAGE_LATENCY_EXPECTED / averageLatency
  const rawLatencyScore = parseFloat(
    ((pingScore * LATENCY_SCORE_PING_WEIGHT) +
      (instabilityScore * LATENCY_SCORE_INSTABILITY_WEIGHT)).toFixed(2)
  )
  const latencyScore = parseFloat((1 - (timeWeight * rawLatencyScore)).toFixed(2))

  const score = (healthScore * HEALTH_SCORE_WEIGHT ) + (latencyScore * LATENCY_SCORE_WEIGHT)

  backend.scoredRequestCount = backend.requestCount
  backend.healthScore = healthScore
  backend.latencyScore = latencyScore
  backend.score = score
  // todo: write scores to a database such as firebase for persistence
  return [healthScore, latencyScore, score]
}
function canRetry(req: Request, resp: Response) {
  if (resp && resp.status < 500) return false // don't retry normal boring errors or success
  if (req.method == "GET" || req.method == "HEAD") return true
  return false
}

function chooseBackends(backends: Backend[], attempted?: Set<Backend>) {
  let b1: Backend | undefined
  let b2: Backend | undefined
  for (let i = 0; i < backends.length; i++) {
    const b = backends[i]
    if (attempted && attempted.has(b)) continue;

    if (!b1) {
      b1 = b
      continue
    }
    if (!b2) {
      b2 = b
      continue
    }

    const old1 = b1
    b1 = bestBackend(b, b1)

    if (old1 != b1) {
      // b1 got replaced, make sure it's not better
      b2 = bestBackend(old1, b2)
    } else {
      b2 = bestBackend(b, b2)
    }
  }

  return [b1, b2]
}

function bestBackend(b1: Backend, b2: Backend) {
  return (b1.score > b2.score ||
    (b1.score == b2.score && b1.requestCount < b2.requestCount)
  ) ? b1
    : b2
}

export const _internal = {
  chooseBackends,
  score
}
