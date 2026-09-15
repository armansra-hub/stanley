"""Confine authenticated foundation requests to the linked Stanley production app."""
import urllib.error
import urllib.parse
import urllib.request


STANLEY_ORIGIN = "https://jarvis-sable-eta.vercel.app"


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Even same-origin redirects are refused: a request is attempted once at
        # its reviewed URL, without forwarding its credentials or POST body.
        raise urllib.error.HTTPError(
            req.full_url, code, "Authenticated Stanley redirect refused", headers, None
        )


def open_app_request(request, *, timeout, context=None):
    url = request.full_url
    parsed = urllib.parse.urlsplit(url)
    if (
        any(ord(char) <= 32 or ord(char) == 127 for char in url)
        or "\\" in url
        or parsed.fragment
        or f"{parsed.scheme}://{parsed.netloc}" != STANLEY_ORIGIN
    ):
        raise ValueError("Authenticated foundation requests require the exact Stanley production origin")
    # A private opener leaves unauthenticated official downloads/profile reads
    # and their normal redirect behavior unchanged. Preserve the caller's TLS
    # context (SBA supplies one explicitly).
    opener = urllib.request.build_opener(
        _RejectRedirects(), urllib.request.HTTPSHandler(context=context)
    )
    return opener.open(request, timeout=timeout)
