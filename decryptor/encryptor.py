import os.path
import sys

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7
from cryptography.hazmat.backends import default_backend

FILENAME_CHARSET = ' ()+,-./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]_abcdefghijklmnopqrstuvwxyz'
FILENAME_CHARSET_INVERSE = {c: i for i, c in enumerate(FILENAME_CHARSET)}

def encode_filename(filename):
    checksum = 0
    for c in filename:
        checksum = (checksum + FILENAME_CHARSET_INVERSE[c]) % len(FILENAME_CHARSET)
    return FILENAME_CHARSET[checksum] + ''.join(
        FILENAME_CHARSET[(FILENAME_CHARSET_INVERSE[c] + checksum + i) % len(FILENAME_CHARSET)]
        for i, c in enumerate(filename)
    ).replace('\\', '~').replace(',', '{').replace('/', '}')

def encrypt(plaintext):
    padder = PKCS7(128).padder()
    padded_plaintext = padder.update(plaintext) + padder.finalize()
    backend = default_backend()
    cipher = Cipher(
        algorithms.AES(b'\xF6\x86\xD8\xC6\x09\xA3\x06\xCF\xD2\x2F\x1B\x75\x01\xDD\x48\x7E'),
        modes.CBC(b'\xBA\x66\x40\x1E\xBB\x6B\xBA\xB7\x63\x34\x03\x1A\x9E\x9D\x73\xDA'),
        backend=backend,
    )
    encryptor = cipher.encryptor()
    return encryptor.update(padded_plaintext) + encryptor.finalize()

if __name__ == '__main__':
    for path in sys.argv[1:]:
        encoded_path = os.path.join(os.path.dirname(path), encode_filename(os.path.basename(path)))
        with open(path, 'rb') as f_in, open(encoded_path, 'wb') as f_out:
            f_out.write(encrypt(f_in.read()))
        print(encoded_path)
