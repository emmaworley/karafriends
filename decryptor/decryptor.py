import os.path
import sys

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7
from cryptography.hazmat.backends import default_backend

FILENAME_CHARSET = ' ()+,-./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]_abcdefghijklmnopqrstuvwxyz'
FILENAME_CHARSET_INVERSE = {c: i for i, c in enumerate(FILENAME_CHARSET)}

def decode_filename(encoded_filename):
    encoded_filename = encoded_filename.replace('~', '\\').replace('{', ',').replace('}', '/')
    checksum = FILENAME_CHARSET_INVERSE[encoded_filename[0]]
    return ''.join(
        FILENAME_CHARSET[FILENAME_CHARSET_INVERSE[c] - checksum - i]
        for i, c in enumerate(encoded_filename[1:])
    )

def decrypt(ciphertext):
    backend = default_backend()
    cipher = Cipher(
        algorithms.AES(b'\xF6\x86\xD8\xC6\x09\xA3\x06\xCF\xD2\x2F\x1B\x75\x01\xDD\x48\x7E'),
        modes.CBC(b'\xBA\x66\x40\x1E\xBB\x6B\xBA\xB7\x63\x34\x03\x1A\x9E\x9D\x73\xDA'),
        backend=backend,
    )
    decryptor = cipher.decryptor()
    padded_plaintext = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = PKCS7(128).unpadder()
    return unpadder.update(padded_plaintext) + unpadder.finalize()

if __name__ == '__main__':
    for path in sys.argv[1:]:
        decoded_path = os.path.join(os.path.dirname(path), decode_filename(os.path.basename(path)))
        with open(path, 'rb') as f_in, open(decoded_path, 'wb') as f_out:
            f_out.write(decrypt(f_in.read()))
        print(decoded_path)
