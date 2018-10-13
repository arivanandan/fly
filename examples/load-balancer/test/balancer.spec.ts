import { expect } from 'chai'
import balancer, { _internal, Backend } from "../src/balancer"

import { AVERAGE_LATENCY_EXPECTED } from '../balancer-config';

async function fakeFetch(req: RequestInfo, init?: RequestInit) {
  return new Response("hi")
}
async function fakeFetchError(req: RequestInfo, init?: RequestInit) {
  return new Response("nooooo", { status: 502 })
}

function healthy() {
  return <Backend>{
    proxy: fakeFetch.bind({}), // same function, different times
    requestCount: 0,
    statuses: Array(3).fill(200),
    latencies: Array(3).fill(AVERAGE_LATENCY_EXPECTED),
    lastError: 0,
    healthScore: 1,
    latencyScore: 1,
    score: 1,
    errorCount: 0
  }
}
function unhealthy(score?: number) {
  const b = healthy()
  const unhealthLatency = AVERAGE_LATENCY_EXPECTED * 2
  b.statuses.push(500, 500, 500)
  b.latencies.push(unhealthLatency, unhealthLatency, unhealthLatency)
  b.healthScore = score || 0.5
  b.latencyScore = score || 0.5
  b.score = score || 0.5
  return b
}
describe("balancing", () => {
  describe("backend scoring", () => {
    it("should score healthy backends high", () => {
      const backend = healthy()
      const [healthScore, latencyScore, score] = _internal.score(backend)

      expect(score).to.eq(1)
    })

    it("should score unhealthy backends low", () => {
      const backend = unhealthy()
      const [healthScore, latencyScore, score] = _internal.score(backend, 0)

      expect(score).to.eq(0.5)
    })

    it("should give less weight to older errors", () => {
      const backend = unhealthy()
      let [healthScore, latencyScore, score] = _internal.score(backend, backend.lastError + 999)
      expect(healthScore).to.eq(0.5)

      score = _internal.score(backend, backend.lastError + 2000)[0] // 2s old error
      expect(score).to.eq(0.6)

      score = _internal.score(backend, backend.lastError + 4000)[0] // 4s old error
      expect(score).to.eq(0.85)

      score = _internal.score(backend, backend.lastError + 9000)[0] // 9s old error
      expect(score).to.eq(0.95)
    })
  })

  describe("backend selection", () => {
    it("should choose healthy backends first", () => {
      const h = [healthy(), healthy()]
      const backends = [unhealthy(), unhealthy(), unhealthy()].concat(h)
      const [b1, b2] = _internal.chooseBackends(backends)

      expect(h.find((e) => e === b1)).to.eq(b1, "Backend 1 should be in selected")
      expect(h.find((e) => e === b2)).to.eq(b2, "Backend 2 should be in selected")
      expect(b1).to.not.eq(b2, "Backend 1 and Backend 2 should be different")
    })

    it("ignores backends that have been tried", () => {
      const h = [healthy(), healthy()]
      const backends = [unhealthy(), unhealthy(), unhealthy()].concat(h)
      const attempted = new Set<Backend>(h)

      const [b1, b2] = _internal.chooseBackends(backends, attempted)
      expect(h.find((e) => e === b1)).to.eq(undefined, "Backend 1 should not be in selected")
      expect(h.find((e) => e === b2)).to.eq(undefined, "Backend 2 should not be in selected")
      expect(b1).to.not.eq(b2, "Backend 1 and Backend 2 should be different")
    })
  })

  describe("backend stats", () => {
    it("should store last 10 statuses", async () => {
      const req = new Request("http://localhost/hello/")
      const fn = balancer([fakeFetch])
      const backend = fn.backends[0]
      const statuses = Array<number>()
      for (let i = 0; i < 20; i++) {
        let resp = await fn(req)
        statuses.push(resp.status)
      }

      expect(backend.statuses.length).to.eq(10)
      expect(backend.statuses).to.deep.eq(statuses.slice(-10))
      expect(backend.healthScore).to.eq(1)
    })

    it("should retry on failure", async () => {
      const fn = balancer([
        fakeFetchError.bind({}),
        fakeFetchError.bind({}),
        fakeFetch
      ])
      // lower health of the last backend so we try errors first
      fn.backends[2].healthScore = 0.1

      const resp = await fn("http://localhost/")
      const used = fn.backends.filter((b) => b.requestCount > 0)

      expect(resp.status).to.eq(200)
      expect(await resp.text()).to.eq("hi")
      expect(used.length).to.be.gte(2) // at least two backends hit
    })
  })
})
