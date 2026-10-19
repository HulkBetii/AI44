import sys
import base64
import cv2
import numpy as np

def decode_qr(img_source):
    try:
        if img_source.startswith('data:image'):
            b64_data = img_source.split(',', 1)[1]
            img_bytes = base64.b64decode(b64_data)
            nparr = np.frombuffer(img_bytes, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        else:
            img = cv2.imread(img_source)
            
        detector = cv2.QRCodeDetector()
        val, points, qrcode = detector.detectAndDecode(img)
        return val
    except Exception as e:
        return ''

if __name__ == '__main__':
    if len(sys.argv) > 1:
        res = decode_qr(sys.argv[1])
        print(res.strip() if res else '')
