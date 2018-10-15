import proxy from "@fly/fetch/proxy"
import balancer from "./src/balancer"

const backends = [
  { fn: proxy, url: "https://example.com" },
  { fn: proxy, url: "https://example.org" }
]

declare var fly: any
fly.http.respondWith(balancer(backends))
