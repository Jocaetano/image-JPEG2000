# image-JPEG2000

Support repository for a fork of Mozilla's PDF.js that adds support for 16 bit signed grayscale JPEG2000 images.

## Build

```
git submodule init
git submodule update
npm install
grunt
```

## Usage

```
  jpxImage.parse(jpxData);
  var width = jpxImage.width;
  var height = jpxImage.height;
  var pixelData = jpxImage.tile.items;
```

jpxData: a Uint8 buffer containing the JPEG2000 code-stream.
pixelData: a Int16 containing the decoded data.
