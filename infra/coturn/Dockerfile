ARG COTURN_VERSION=4.6.3
FROM coturn/coturn:${COTURN_VERSION}

LABEL org.opencontainers.image.title="Love Home coturn" \
      org.opencontainers.image.description="Multi-architecture coturn image for Love Home"

USER root
COPY docker-entrypoint.sh /usr/local/bin/love-coturn-entrypoint
RUN chmod 0755 /usr/local/bin/love-coturn-entrypoint

ENTRYPOINT ["/usr/local/bin/love-coturn-entrypoint"]
