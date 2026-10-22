# Tubelight's server browser (app/browser.py starts one per user, on demand): headless Chromium driven over CDP.
# No LAN: it sits on the internal tl-browser network and reaches the web only through tl-egress-proxy.
# Build on the server: docker build -t tubelight-browser agent-service/browser
FROM alpine:3.22
RUN apk add --no-cache chromium font-dejavu font-noto-emoji socat \
 && adduser -D -u 1000 tl
USER tl
ENV HOME=/tmp
# Chromium only listens on localhost; socat makes CDP reachable on 9223 from the agent (the only other member of tl-browser).
ENTRYPOINT ["sh", "-c", "socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 & exec chromium-browser --remote-debugging-port=9222 \"$@\"", "chromium"]
