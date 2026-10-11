#!/usr/bin/env python3
"""
App Store signing for the GitHub build (D-53), through the App Store Connect API key in the repository's secrets.

  signing.py setup <workdir>    makes an Apple Distribution certificate (key made here, never stored) and an App Store
                                provisioning profile for com.bedochat.app, and writes cert.p12, profile.mobileprovision
                                and signing.json into <workdir>. First it removes what earlier builds made (their
                                profiles named "Bedo Chat CI ..." and those profiles' certificates), so at most one is left.
  signing.py cleanup <workdir>  nothing to do: the next build removes this build's certificate and profile (Apple may
                                still be processing the upload, so they are kept until then).

Needs ASC_KEY, ASC_KEY_ID, ASC_ISSUER_ID, BUNDLE_ID in the environment. Only the standard library, pyjwt and
cryptography (installed by the workflow).
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

import jwt
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

API = 'https://api.appstoreconnect.apple.com/v1'
PREFIX = 'Bedo Chat CI'


def token() -> str:
    key = os.environ['ASC_KEY'].replace('\\n', '\n')
    now = int(time.time())
    return jwt.encode(
        {'iss': os.environ['ASC_ISSUER_ID'], 'iat': now, 'exp': now + 15 * 60, 'aud': 'appstoreconnect-v1'},
        key,
        algorithm='ES256',
        headers={'kid': os.environ['ASC_KEY_ID'], 'typ': 'JWT'},
    )


def call(method: str, path: str, body: dict | None = None) -> dict:
    request = urllib.request.Request(
        path if path.startswith('http') else f'{API}{path}',
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': f'Bearer {token()}', 'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            text = response.read().decode() or '{}'
            return json.loads(text)
    except urllib.error.HTTPError as error:
        detail = error.read().decode()
        try:
            errors = json.loads(detail).get('errors', [])
            detail = '; '.join(f"{item.get('title')}: {item.get('detail')}" for item in errors) or detail
        except ValueError:
            pass
        print(f'::error title=Apple signing::{method} {path.split("?")[0]} answered {error.code}: {detail}')
        sys.exit(1)


def remove_previous() -> None:
    profiles = call('GET', f'/profiles?filter[name]={urllib.request.quote(PREFIX)}&limit=200').get('data', [])
    for profile in profiles:
        if not profile['attributes']['name'].startswith(PREFIX):
            continue
        certificates = call('GET', f"/profiles/{profile['id']}/certificates?limit=50").get('data', [])
        call('DELETE', f"/profiles/{profile['id']}")
        for certificate in certificates:
            call('DELETE', f"/certificates/{certificate['id']}")
        print(f"Removed {profile['attributes']['name']} and {len(certificates)} certificate(s)")


def setup(workdir: str) -> None:
    os.makedirs(workdir, exist_ok=True)
    bundle = os.environ['BUNDLE_ID']
    remove_previous()

    found = call('GET', f'/bundleIds?filter[identifier]={bundle}&limit=20').get('data', [])
    bundle_ids = [item for item in found if item['attributes']['identifier'] == bundle]
    if not bundle_ids:
        print(f'::error title=Apple signing::the bundle ID {bundle} is not registered (Certificates, Identifiers & Profiles)')
        sys.exit(1)
    bundle_id = bundle_ids[0]['id']
    capabilities = call('GET', f'/bundleIds/{bundle_id}/bundleIdCapabilities?limit=50').get('data', [])
    if not any(item['attributes']['capabilityType'] == 'PUSH_NOTIFICATIONS' for item in capabilities):
        call('POST', '/bundleIdCapabilities', {'data': {
            'type': 'bundleIdCapabilities',
            'attributes': {'capabilityType': 'PUSH_NOTIFICATIONS'},
            'relationships': {'bundleId': {'data': {'type': 'bundleIds', 'id': bundle_id}}},
        }})
        print('Turned on Push Notifications for the bundle ID')

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    csr = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, PREFIX), x509.NameAttribute(NameOID.COUNTRY_NAME, 'GB')]))
        .sign(key, hashes.SHA256())
    )
    created = call('POST', '/certificates', {'data': {
        'type': 'certificates',
        'attributes': {'certificateType': 'DISTRIBUTION', 'csrContent': csr.public_bytes(serialization.Encoding.PEM).decode()},
    }})['data']
    certificate = x509.load_der_x509_certificate(base64.b64decode(created['attributes']['certificateContent']))
    password = base64.urlsafe_b64encode(os.urandom(18)).decode()
    with open(os.path.join(workdir, 'cert.p12'), 'wb') as handle:
        handle.write(pkcs12.serialize_key_and_certificates(
            b'Bedo Chat CI', key, certificate, None, serialization.BestAvailableEncryption(password.encode())))

    name = f"{PREFIX} {os.environ.get('GITHUB_RUN_NUMBER', int(time.time()))}"
    profile = call('POST', '/profiles', {'data': {
        'type': 'profiles',
        'attributes': {'name': name, 'profileType': 'IOS_APP_STORE'},
        'relationships': {
            'bundleId': {'data': {'type': 'bundleIds', 'id': bundle_id}},
            'certificates': {'data': [{'type': 'certificates', 'id': created['id']}]},
        },
    }})['data']
    with open(os.path.join(workdir, 'profile.mobileprovision'), 'wb') as handle:
        handle.write(base64.b64decode(profile['attributes']['profileContent']))
    with open(os.path.join(workdir, 'signing.json'), 'w') as handle:
        json.dump({'p12Password': password, 'profileName': name, 'profileUuid': profile['attributes']['uuid']}, handle)
    print(f"Made the distribution certificate and the App Store profile {name}")


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('setup', 'cleanup'):
        print(__doc__)
        sys.exit(2)
    if sys.argv[1] == 'setup':
        setup(sys.argv[2])
