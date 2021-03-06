function [] = imcompare(i1name, i2name, size, precision)
  % ex:
  % imcompare('data/000000.raw', '/test/out_000000.raw', [512 512 1], 'int16');
  % imcompare('data/cameraman.10.raw', '/out_cameraman.10.raw', [256 256 1], 'uint8')
  % imcompare('data/saturn.raw', 'out_saturn.raw', [1500 1200 1], 'uint8')
  I1 =multibandread(i1name, size, precision, 0, 'bip', 'ieee-le');
  I2 =multibandread(i2name, size, precision, 0, 'bip', 'ieee-le');
  imshow(abs(I1-I2), [])
  figure;imshow([I1 I2], [])
  figure;imshow([I2], [])

end
