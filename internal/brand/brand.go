package brand

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/png"
	"sync"

	brandassets "github.com/alikwelyn/bigducks-live/imgs"
	"golang.org/x/image/draw"
)

var (
	iconOnce sync.Once
	iconData []byte
	iconErr  error
)

func LogoPNG() []byte {
	return append([]byte(nil), brandassets.PNG...)
}

func IconICO() ([]byte, error) {
	iconOnce.Do(func() { iconData, iconErr = buildICO(brandassets.PNG, []int{16, 24, 32, 48, 64, 128, 256}) })
	return append([]byte(nil), iconData...), iconErr
}

func buildICO(source []byte, sizes []int) ([]byte, error) {
	decoded, err := png.Decode(bytes.NewReader(source))
	if err != nil {
		return nil, fmt.Errorf("decode brand PNG: %w", err)
	}
	frames := make([][]byte, 0, len(sizes))
	for _, size := range sizes {
		if size < 1 || size > 256 {
			return nil, fmt.Errorf("invalid icon size %d", size)
		}
		target := image.NewNRGBA(image.Rect(0, 0, size, size))
		draw.CatmullRom.Scale(target, target.Bounds(), decoded, decoded.Bounds(), draw.Over, nil)
		var encoded bytes.Buffer
		if err := png.Encode(&encoded, target); err != nil {
			return nil, fmt.Errorf("encode %dpx icon frame: %w", size, err)
		}
		frames = append(frames, encoded.Bytes())
	}

	const headerSize = 6
	directorySize := len(frames) * 16
	total := headerSize + directorySize
	for _, frame := range frames {
		total += len(frame)
	}
	result := make([]byte, total)
	binary.LittleEndian.PutUint16(result[2:4], 1)
	binary.LittleEndian.PutUint16(result[4:6], uint16(len(frames)))
	offset := headerSize + directorySize
	for index, frame := range frames {
		size := sizes[index]
		entry := result[headerSize+index*16 : headerSize+(index+1)*16]
		if size < 256 {
			entry[0] = byte(size)
			entry[1] = byte(size)
		}
		entry[2] = 0
		entry[3] = 0
		binary.LittleEndian.PutUint16(entry[4:6], 1)
		binary.LittleEndian.PutUint16(entry[6:8], 32)
		binary.LittleEndian.PutUint32(entry[8:12], uint32(len(frame)))
		binary.LittleEndian.PutUint32(entry[12:16], uint32(offset))
		copy(result[offset:], frame)
		offset += len(frame)
	}
	return result, nil
}
