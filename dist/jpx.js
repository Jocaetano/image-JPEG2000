/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* globals ArithmeticDecoder, globalScope, log2, readUint16, readUint32,
           info, warn */

'use strict';

var JpxImage = (function JpxImageClosure() {

	function JpxImage() {

	}

	JpxImage.prototype = {

		parse: function JpxImage_parse(data) {

			var head = readUint16(data, 0);
			// No box header, immediate start of codestream (SOC)
			if (head === 0xFF4F) {
				this.parseCodestream(data, 0, data.length);
				return;
			}
			console.log("Header");
		},

		parseCodestream: function JpxImage_parseCodestream(data, start, end) {
			var context = {};
			var position = start;
			while (position + 1 < end) {
				var code = readUint16(data, position);
				position += 2;

				var length = 0, j, spqcds, dataEnd;
				switch (code) {
					case 0xFF4F: // Start of codestream (SOC)
						break;
					case 0xFF51: // Image and tile size (SIZ)
						length = readUint16(data, position);
						var siz = {};
						siz.Xsiz = readUint32(data, position + 4);
						siz.Ysiz = readUint32(data, position + 8);
						siz.XOsiz = readUint32(data, position + 12);
						siz.YOsiz = readUint32(data, position + 16);
						siz.XTsiz = readUint32(data, position + 20);
						siz.YTsiz = readUint32(data, position + 24);
						siz.XTOsiz = readUint32(data, position + 28);
						siz.YTOsiz = readUint32(data, position + 32);
						j = position + 38;
						var component = {
							precision: (data[j] & 0x7F) + 1,
							isSigned: !!(data[j] & 0x80),
							XRsiz: data[j + 1],
							YRsiz: data[j + 1]
						};
						calculateComponentDimensions(component, siz);
						context.SIZ = siz;
						context.component = component;
						calculateTileGrids(context, component);
						break;
					case 0xFF52: // Coding style default (COD)
						length = readUint16(data, position);
						var cod = {};
						j = position + 7;
						cod.decompositionLevelsCount = data[j++];
						cod.xcb = (data[j++] & 0xF) + 2;
						cod.ycb = (data[j++] & 0xF) + 2;
						j += 2;
						context.COD = cod;
						break;
					case 0xFF5C: // Quantization default (QCD)
						length = readUint16(data, position);
						j = position + 2;
						var qcd = {};
						qcd.guardBits = data[j++] >> 5;
						spqcds = [];
						while (j < length + position) {
							spqcds.push(data[j++] >> 3);
						}
						qcd.SPqcds = spqcds;
						context.QCD = qcd;
						break;
					case 0xFF90: // Start of tile-part (SOT)
						length = readUint16(data, position);
						var tileLength = readUint32(data, position + 4);
						dataEnd = tileLength + position - 2;
						break;
					case 0xFF93: // Start of data (SOD)
						initializeTile(context);
						buildPackets(context);
						// moving to the end of the data
						length = dataEnd - position;
						parseTilePackets(context, data, position, length);
						break;
					case 0xFFD9: // End of codestream (EOC)
						break;
					default:
						console.log('JPX Error: Unknown codestream code: ' + code.toString(16));
				}
				position += length;
			}
			this.tile = transformComponents(context);
			this.width = context.SIZ.Xsiz - context.SIZ.XOsiz;
			this.height = context.SIZ.Ysiz - context.SIZ.YOsiz;
		}
	};

	function calculateComponentDimensions(component, siz) {
		// Section B.2 Component mapping
		component.x0 = Math.ceil(siz.XOsiz / component.XRsiz);
		component.x1 = Math.ceil(siz.Xsiz / component.XRsiz);
		component.y0 = Math.ceil(siz.YOsiz / component.YRsiz);
		component.y1 = Math.ceil(siz.Ysiz / component.YRsiz);
		component.width = component.x1 - component.x0;
		component.height = component.y1 - component.y0;
	}

	function calculateTileGrids(context, component) {
		var siz = context.SIZ;
		// Section B.3 Division into tile and tile-components
		var tile = {};
		tile.tx0 = Math.max(siz.XTOsiz, siz.XOsiz);
		tile.ty0 = Math.max(siz.YTOsiz, siz.YOsiz);
		tile.tx1 = Math.min(siz.XTOsiz + siz.XTsiz, siz.Xsiz);
		tile.ty1 = Math.min(siz.YTOsiz + siz.YTsiz, siz.Ysiz);
		tile.width = tile.tx1 - tile.tx0;
		tile.height = tile.ty1 - tile.ty0;
		context.tile = tile;

		var tileComponent = {};
		tileComponent.tcx0 = Math.ceil(tile.tx0 / component.XRsiz);
		tileComponent.tcy0 = Math.ceil(tile.ty0 / component.YRsiz);
		tileComponent.tcx1 = Math.ceil(tile.tx1 / component.XRsiz);
		tileComponent.tcy1 = Math.ceil(tile.ty1 / component.YRsiz);
		tileComponent.width = tileComponent.tcx1 - tileComponent.tcx0;
		tileComponent.height = tileComponent.tcy1 - tileComponent.tcy0;
		tile.component = tileComponent;

	}
	function getBlocksDimensions(context, component, r) {
		var cod = component.codingStyleParameters;
		var result = {};
		
		// calculate codeblock size as described in section B.7
		result.xcb_ = (r > 0 ? Math.min(cod.xcb, 14) : Math.min(cod.xcb, 15));
		result.ycb_ = (r > 0 ? Math.min(cod.ycb, 14) : Math.min(cod.ycb, 15));
		return result;
	}
	function buildPrecincts(context, resolution, dimensions) {
		// Section B.6 Division resolution to precincts
		var precinctWidth = 1 << 15;
		var precinctHeight = 1 << 15;
		// Jasper introduces codeblock groups for mapping each subband codeblocks
		// to precincts. Precinct partition divides a resolution according to width
		// and height parameters. The subband that belongs to the resolution level
		// has a different size than the level, unless it is the zero resolution.

		// From Jasper documentation: jpeg2000.pdf, section K: Tier-2 coding:
		// The precinct partitioning for a particular subband is derived from a
		// partitioning of its parent LL band (i.e., the LL band at the next higher
		// resolution level)... The LL band associated with each resolution level is
		// divided into precincts... Each of the resulting precinct regions is then
		// mapped into its child subbands (if any) at the next lower resolution
		// level. This is accomplished by using the coordinate transformation
		// (u, v) = (ceil(x/2), ceil(y/2)) where (x, y) and (u, v) are the
		// coordinates of a point in the LL band and child subband, respectively.
		var isZeroRes = resolution.resLevel === 0;
		var precinctWidthInSubband = 1 << (15 + (isZeroRes ? 0 : -1));
		var precinctHeightInSubband = 1 << (15 + (isZeroRes ? 0 : -1));
		var numprecinctswide = (resolution.trx1 > resolution.trx0 ? Math.ceil(resolution.trx1 / precinctWidth) - Math.floor(resolution.trx0 / precinctWidth) : 0);
		var numprecinctshigh = (resolution.try1 > resolution.try0 ? Math.ceil(resolution.try1 / precinctHeight) - Math.floor(resolution.try0 / precinctHeight) : 0);
		var numprecincts = numprecinctswide * numprecinctshigh;

		resolution.precinctParameters = {
			precinctWidth: precinctWidth,
			precinctHeight: precinctHeight,
			numprecinctswide: numprecinctswide,
			numprecinctshigh: numprecinctshigh,
			numprecincts: numprecincts,
			precinctWidthInSubband: precinctWidthInSubband,
			precinctHeightInSubband: precinctHeightInSubband
		};
	}
	function buildCodeblocks(context, subband, dimensions) {
		// Section B.7 Division sub-band into code-blocks
		var xcb_ = dimensions.xcb_;
		var ycb_ = dimensions.ycb_;
		var codeblockWidth = 1 << xcb_;
		var codeblockHeight = 1 << ycb_;
		var cbx0 = subband.tbx0 >> xcb_;
		var cby0 = subband.tby0 >> ycb_;
		var cbx1 = (subband.tbx1 + codeblockWidth - 1) >> xcb_;
		var cby1 = (subband.tby1 + codeblockHeight - 1) >> ycb_;
		var precinctParameters = subband.resolution.precinctParameters;
		var codeblocks = [];
		var precincts = [];
		var i, j, codeblock, precinctNumber;
		for (j = cby0; j < cby1; j++) {
			for (i = cbx0; i < cbx1; i++) {
				codeblock = {
					cbx: i,
					cby: j,
					tbx0: codeblockWidth * i,
					tby0: codeblockHeight * j,
					tbx1: codeblockWidth * (i + 1),
					tby1: codeblockHeight * (j + 1)
				};

				codeblock.tbx0_ = Math.max(subband.tbx0, codeblock.tbx0);
				codeblock.tby0_ = Math.max(subband.tby0, codeblock.tby0);
				codeblock.tbx1_ = Math.min(subband.tbx1, codeblock.tbx1);
				codeblock.tby1_ = Math.min(subband.tby1, codeblock.tby1);

				// Calculate precinct number for this codeblock, codeblock position
				// should be relative to its subband, use actual dimension and position
				// See comment about codeblock group width and height
				var pi = Math.floor((codeblock.tbx0_ - subband.tbx0) / precinctParameters.precinctWidthInSubband);
				var pj = Math.floor((codeblock.tby0_ - subband.tby0) / precinctParameters.precinctHeightInSubband);
				precinctNumber = pi + (pj * precinctParameters.numprecinctswide);

				codeblock.precinctNumber = precinctNumber;
				codeblock.subbandType = subband.type;
				codeblock.Lblock = 3;
				codeblocks.push(codeblock);
				// building precinct for the sub-band
				var precinct = precincts[precinctNumber];
				if (precinct !== undefined) {
					if (i < precinct.cbxMin)
						precinct.cbxMin = i;
					else if (i > precinct.cbxMax)
						precinct.cbxMax = i;

					if (j < precinct.cbyMin)
						precinct.cbxMin = j;
					else if (j > precinct.cbyMax)
						precinct.cbyMax = j;
				} else {
					precincts[precinctNumber] = precinct = {
						cbxMin: i,
						cbyMin: j,
						cbxMax: i,
						cbyMax: j
					};
				}
				codeblock.precinct = precinct;
			}
		}
		subband.codeblockParameters = {
			codeblockWidth: xcb_,
			codeblockHeight: ycb_,
			numcodeblockwide: cbx1 - cbx0 + 1,
			numcodeblockhigh: cby1 - cby0 + 1
		};
		subband.codeblocks = codeblocks;
		subband.precincts = precincts;
	}
	function createPacket(resolution) {
		var precinctCodeblocks = [];
		// Section B.10.8 Order of info in packet
		var subbands = resolution.subbands;
		// sub-bands already ordered in 'LL', 'HL', 'LH', and 'HH' sequence
		for (var i = 0, ii = subbands.length; i < ii; i++) {
			var subband = subbands[i];
			var codeblocks = subband.codeblocks;
			for (var j = 0, jj = codeblocks.length; j < jj; j++) {
				var codeblock = codeblocks[j];
				if (codeblock.precinctNumber)
					continue;
				precinctCodeblocks.push(codeblock);
			}
		}
		return {
			layerNumber: 0,
			codeblocks: precinctCodeblocks
		};
	}
	function LayerResolutionComponentPositionIterator(context) {
		var tile = context.tile;
		var maxDecompositionLevelsCount = Math.max(0, tile.component.codingStyleParameters.decompositionLevelsCount);

		var r = 0, k = true;

		this.nextPacket = function JpxImage_nextPacket() {
			// Section B.12.1.1 Layer-resolution-component-position
			for (; r <= maxDecompositionLevelsCount; r++) {
				var component = tile.component;
				if (r > component.codingStyleParameters.decompositionLevelsCount)
					continue;

				var resolution = component.resolutions[r];
				if (k) {
					var packet = createPacket(resolution);
					k = !k;
					return packet;
				}
				k = !k;
			}
			r = 0;
		};
	}

	function buildPackets(context) {
		var tile = context.tile;
		// Creating resolutions and sub-bands for each component
		var component = tile.component;
		var decompositionLevelsCount =
			component.codingStyleParameters.decompositionLevelsCount;
		// Section B.5 Resolution levels and sub-bands
		var resolutions = [];
		var subbands = [];
		for (var r = 0; r <= decompositionLevelsCount; r++) {
			var blocksDimensions = getBlocksDimensions(context, component, r);
			var resolution = {};
			var scale = 1 << (decompositionLevelsCount - r);
			resolution.trx0 = Math.ceil(component.tcx0 / scale);
			resolution.try0 = Math.ceil(component.tcy0 / scale);
			resolution.trx1 = Math.ceil(component.tcx1 / scale);
			resolution.try1 = Math.ceil(component.tcy1 / scale);
			resolution.resLevel = r;
			buildPrecincts(context, resolution, blocksDimensions);
			resolutions.push(resolution);

			var subband;
			if (r === 0) {
				// one sub-band (LL) with last decomposition
				subband = {};
				subband.type = 'LL';
				subband.tbx0 = Math.ceil(component.tcx0 / scale);
				subband.tby0 = Math.ceil(component.tcy0 / scale);
				subband.tbx1 = Math.ceil(component.tcx1 / scale);
				subband.tby1 = Math.ceil(component.tcy1 / scale);
				subband.resolution = resolution;
				buildCodeblocks(context, subband, blocksDimensions);
				subbands.push(subband);
				resolution.subbands = [subband];
			} else {
				var bscale = 1 << (decompositionLevelsCount - r + 1);
				var resolutionSubbands = [];
				// three sub-bands (HL, LH and HH) with rest of decompositions
				subband = {};
				subband.type = 'HL';
				subband.tbx0 = Math.ceil(component.tcx0 / bscale - 0.5);
				subband.tby0 = Math.ceil(component.tcy0 / bscale);
				subband.tbx1 = Math.ceil(component.tcx1 / bscale - 0.5);
				subband.tby1 = Math.ceil(component.tcy1 / bscale);
				subband.resolution = resolution;
				buildCodeblocks(context, subband, blocksDimensions);
				subbands.push(subband);
				resolutionSubbands.push(subband);

				subband = {};
				subband.type = 'LH';
				subband.tbx0 = Math.ceil(component.tcx0 / bscale);
				subband.tby0 = Math.ceil(component.tcy0 / bscale - 0.5);
				subband.tbx1 = Math.ceil(component.tcx1 / bscale);
				subband.tby1 = Math.ceil(component.tcy1 / bscale - 0.5);
				subband.resolution = resolution;
				buildCodeblocks(context, subband, blocksDimensions);
				subbands.push(subband);
				resolutionSubbands.push(subband);

				subband = {};
				subband.type = 'HH';
				subband.tbx0 = Math.ceil(component.tcx0 / bscale - 0.5);
				subband.tby0 = Math.ceil(component.tcy0 / bscale - 0.5);
				subband.tbx1 = Math.ceil(component.tcx1 / bscale - 0.5);
				subband.tby1 = Math.ceil(component.tcy1 / bscale - 0.5);
				subband.resolution = resolution;
				buildCodeblocks(context, subband, blocksDimensions);
				subbands.push(subband);
				resolutionSubbands.push(subband);

				resolution.subbands = resolutionSubbands;
			}
		}
		component.resolutions = resolutions;
		component.subbands = subbands;
		
		// Generate the packets sequence
		tile.packetsIterator = new LayerResolutionComponentPositionIterator(context);

	}
	function parseTilePackets(context, data, offset, dataLength) {
		var position = 0;
		var buffer, bufferSize = 0, skipNextBit = false;

		function readBits(count) {
			while (bufferSize < count) {
				var b = data[offset + position];
				position++;
				if (skipNextBit) {
					buffer = (buffer << 7) | b;
					bufferSize += 7;
					skipNextBit = false;
				} else {
					buffer = (buffer << 8) | b;
					bufferSize += 8;
				}
				if (b === 0xFF) {
					skipNextBit = true;
				}
			}
			bufferSize -= count;
			return (buffer >>> bufferSize) & ((1 << count) - 1);
		}

		function skipMarkerIfEqual(value) {
			if (data[offset + position - 1] === 0xFF &&
				data[offset + position] === value) {
				skipBytes(1);
				return true;
			} else if (data[offset + position] === 0xFF &&
				data[offset + position + 1] === value) {
				skipBytes(2);
				return true;
			}
			return false;
		}

		function skipBytes(count) {
			position += count;
		}

		function alignToByte() {
			bufferSize = 0;
			if (skipNextBit) {
				position++;
				skipNextBit = false;
			}
		}

		function readCodingpasses() {
			if (readBits(1) === 0)
				return 1;
			if (readBits(1) === 0)
				return 2;
			var value = readBits(2);
			if (value < 3)
				return value + 3;
			value = readBits(5);
			if (value < 31)
				return value + 6;
			value = readBits(7);
			return value + 37;
		}

		var tile = context.tile;
		var packetsIterator = tile.packetsIterator;
		while (position < dataLength) {
			alignToByte();
			var packet = packetsIterator.nextPacket();
			if (packet === undefined) {
				//No more packets. Stream is probably truncated.
				return;
			}
			if (!readBits(1))
				continue;

			var queue = [], codeblock;
			for (var i = 0, ii = packet.codeblocks.length; i < ii; i++) {
				codeblock = packet.codeblocks[i];
				var precinct = codeblock.precinct;
				var codeblockColumn = codeblock.cbx - precinct.cbxMin;
				var codeblockRow = codeblock.cby - precinct.cbyMin;
				var codeblockIncluded = false;
				var firstTimeInclusion = false;
				var valueReady;
				if (codeblock['included'] !== undefined)
					codeblockIncluded = !!readBits(1);
				else {
					// reading inclusion tree
					precinct = codeblock.precinct;
					var inclusionTree, zeroBitPlanesTree;
					if (precinct['inclusionTree'] !== undefined) {
						inclusionTree = precinct.inclusionTree;
					} else {
						// building inclusion and zero bit-planes trees
						var width = precinct.cbxMax - precinct.cbxMin + 1;
						var height = precinct.cbyMax - precinct.cbyMin + 1;
						inclusionTree = new InclusionTree(width, height);
						zeroBitPlanesTree = new TagTree(width, height);
						precinct.inclusionTree = inclusionTree;
						precinct.zeroBitPlanesTree = zeroBitPlanesTree;
					}

					if (inclusionTree.reset(codeblockColumn, codeblockRow)) {
						while (true) {
							if (readBits(1)) {
								valueReady = !inclusionTree.nextLevel();
								if (valueReady) {
									codeblock.included = true;
									codeblockIncluded = firstTimeInclusion = true;
									break;
								}
							} else {
								inclusionTree.incrementValue();
								break;
							}
						}
					}
				}
				if (!codeblockIncluded)
					continue;

				if (firstTimeInclusion) {
					zeroBitPlanesTree = precinct.zeroBitPlanesTree;
					zeroBitPlanesTree.reset(codeblockColumn, codeblockRow);
					while (true) {
						if (readBits(1)) {
							valueReady = !zeroBitPlanesTree.nextLevel();
							if (valueReady)
								break;
						} else
							zeroBitPlanesTree.incrementValue();
					}
					codeblock.zeroBitPlanes = zeroBitPlanesTree.value;
				}
				var codingpasses = readCodingpasses();
				while (readBits(1))
					codeblock.Lblock++;

				var codingpassesLog2 = log2(codingpasses);
				// rounding down log2
				var bits = ((codingpasses < (1 << codingpassesLog2)) ?
					codingpassesLog2 - 1 : codingpassesLog2) + codeblock.Lblock;
				var codedDataLength = readBits(bits);
				queue.push({
					codeblock: codeblock,
					codingpasses: codingpasses,
					dataLength: codedDataLength
				});
			}
			alignToByte();

			while (queue.length > 0) {
				var packetItem = queue.shift();
				codeblock = packetItem.codeblock;
				if (codeblock['data'] === undefined) {
					codeblock.data = [];
				}
				codeblock.data.push({
					data: data,
					start: offset + position,
					end: offset + position + packetItem.dataLength,
					codingpasses: packetItem.codingpasses
				});
				position += packetItem.dataLength;
			}
		}
		return position;
	}

	function copyCoefficients(coefficients, levelWidth, levelHeight, subband,
		delta, mb) {
		var x0 = subband.tbx0;
		var y0 = subband.tby0;
		var width = subband.tbx1 - subband.tbx0;
		var codeblocks = subband.codeblocks;
		var right = subband.type.charAt(0) === 'H' ? 1 : 0;
		var bottom = subband.type.charAt(1) === 'H' ? levelWidth : 0;

		for (var i = 0, ii = codeblocks.length; i < ii; ++i) {
			var codeblock = codeblocks[i];
			var blockWidth = codeblock.tbx1_ - codeblock.tbx0_;
			var blockHeight = codeblock.tby1_ - codeblock.tby0_;
			if (blockWidth === 0 || blockHeight === 0) 
				continue;
			
			if (codeblock['data'] === undefined)
				continue;

			var bitModel, currentCodingpassType;
			bitModel = new BitModel(blockWidth, blockHeight, codeblock.subbandType, codeblock.zeroBitPlanes, mb);
			currentCodingpassType = 2; // first bit plane starts from cleanup

			// collect data
			var data = codeblock.data, totalLength = 0, codingpasses = 0;
			var j, jj, dataItem;
			for (j = 0, jj = data.length; j < jj; j++) {
				dataItem = data[j];
				totalLength += dataItem.end - dataItem.start;
				codingpasses += dataItem.codingpasses;
			}
			var encodedData = new Int16Array(totalLength);
			var position = 0;
			for (j = 0, jj = data.length; j < jj; j++) {
				dataItem = data[j];
				var chunk = dataItem.data.subarray(dataItem.start, dataItem.end);
				encodedData.set(chunk, position);
				position += chunk.length;
			}
			// decoding the item
			var decoder = new ArithmeticDecoder(encodedData, 0, totalLength);
			bitModel.setDecoder(decoder);

			for (j = 0; j < codingpasses; j++) {
				switch (currentCodingpassType) {
					case 0:
						bitModel.runSignificancePropogationPass();
						break;
					case 1:
						bitModel.runMagnitudeRefinementPass();
						break;
					case 2:
						bitModel.runCleanupPass();
						break;
				}
				currentCodingpassType = (currentCodingpassType + 1) % 3;
			}

			var offset = (codeblock.tbx0_ - x0) + (codeblock.tby0_ - y0) * width;
			var sign = bitModel.coefficentsSign;
			var magnitude = bitModel.coefficentsMagnitude;
			var bitsDecoded = bitModel.bitsDecoded;
			var k, n, nb;
			position = 0;
			// Do the interleaving of Section F.3.3 here, so we do not need
			// to copy later. LL level is not interleaved, just copied.
			var interleave = (subband.type !== 'LL');
			for (j = 0; j < blockHeight; j++) {
				var row = (offset / width) | 0; // row in the non-interleaved subband
				var levelOffset = 2 * row * (levelWidth - width) + right + bottom;
				for (k = 0; k < blockWidth; k++) {
					n = magnitude[position];
					if (n !== 0) {
						n *= delta;
						if (sign[position] !== 0)
							n = -n;
						nb = bitsDecoded[position];
						var pos = interleave ? (levelOffset + (offset << 1)) : offset;
						if (1 && (nb >= mb))
							coefficients[pos] = n;
						else
							coefficients[pos] = n * (1 << (mb - nb));
					}
					offset++;
					position++;
				}
				offset += width - blockWidth;
			}
		}
	}
	function transformTile(context, tile) {
		var component = tile.component;
		var codingStyleParameters = component.codingStyleParameters;
		var quantizationParameters = component.quantizationParameters;
		var decompositionLevelsCount = codingStyleParameters.decompositionLevelsCount;
		var spqcds = quantizationParameters.SPqcds;
		var guardBits = quantizationParameters.guardBits;

		var transform = new ReversibleTransform();

		var subbandCoefficients = [];
		var b = 0;
		for (var i = 0; i <= decompositionLevelsCount; i++) {
			var resolution = component.resolutions[i];

			var width = resolution.trx1 - resolution.trx0;
			var height = resolution.try1 - resolution.try0;
			// Allocate space for the whole sublevel.
			var coefficients = new Float32Array(width * height);

			for (var j = 0, jj = resolution.subbands.length; j < jj; j++) {
				var subband = resolution.subbands[j];

				// calulate quantization coefficient (Section E.1.1.1)
				var delta = 1;
				var mb = (guardBits + spqcds[b] - 1);
				b++;

				// In the first resolution level, copyCoefficients will fill the
				// whole array with coefficients. In the succeding passes,
				// copyCoefficients will consecutively fill in the values that belong
				// to the interleaved positions of the HL, LH, and HH coefficients.
				// The LL coefficients will then be interleaved in Transform.iterate().
				copyCoefficients(coefficients, width, height, subband, delta, mb);
			}
			subbandCoefficients.push({
				width: width,
				height: height,
				items: coefficients
			});
		}

		var result = transform.calculate(subbandCoefficients, component.tcx0, component.tcy0);
		return {
			left: component.tcx0,
			top: component.tcy0,
			width: result.width,
			height: result.height,
			items: result.items
		};
	}

	function transformComponents(context) {
		var component = context.component;
		var tile = context.tile;
		var transformedTile = transformTile(context, tile);

		var tile0 = transformedTile;
		var out = new Int16Array(tile0.items.length);
		var result = {
			left: tile0.left,
			top: tile0.top,
			width: tile0.width,
			height: tile0.height,
			items: out
		};

		// Section G.2.2 Inverse multi component transform

		var isSigned = component.isSigned;
		var items = transformedTile.items;

		if (isSigned)
			out.set(items);
		else {
			var shift = component.precision - 8;
			var offset = (128 << shift) + 0.5;
			for (var i = 0, ii = items.length; i < ii; i++)
				out[i] = (items[i] + offset);
		}

		return result;
	}

	function initializeTile(context) {
		var tile = context.tile;
		var component = tile.component;
		component.quantizationParameters = context.QCD;
		component.codingStyleParameters = context.COD;

		tile.codingStyleDefaultParameters = context.COD;
	}

	// Section B.10.2 Tag trees
	var TagTree = (function TagTreeClosure() {
		function TagTree(width, height) {
			var levelsLength = log2(Math.max(width, height)) + 1;
			this.levels = [];
			for (var i = 0; i < levelsLength; i++) {
				var level = {
					width: width,
					height: height,
					items: []
				};
				this.levels.push(level);
				width = Math.ceil(width / 2);
				height = Math.ceil(height / 2);
			}
		}
		TagTree.prototype = {

			reset: function TagTree_reset(i, j) {
				var currentLevel = 0, value = 0, level;
				while (currentLevel < this.levels.length) {
					level = this.levels[currentLevel];
					var index = i + j * level.width;
					level.index = index;
					if (level.items[index] !== undefined) {
						value = level.items[index];
						break;
					}
					i >>= 1;
					j >>= 1;
					currentLevel++;
				}
				currentLevel--;
				level = this.levels[currentLevel];
				level.items[level.index] = value;
				this.currentLevel = currentLevel;
				delete this.value;
			},

			incrementValue: function TagTree_incrementValue() {
				var level = this.levels[this.currentLevel];
				level.items[level.index]++;
			},

			nextLevel: function TagTree_nextLevel() {
				var currentLevel = this.currentLevel;
				var level = this.levels[currentLevel];
				var value = level.items[level.index];
				currentLevel--;
				if (currentLevel < 0) {
					this.value = value;
					return false;
				}

				this.currentLevel = currentLevel;
				level = this.levels[currentLevel];
				level.items[level.index] = value;
				return true;
			}
		};

		return TagTree;
	})();

	var InclusionTree = (function InclusionTreeClosure() {

		function InclusionTree(width, height) {
			var levelsLength = log2(Math.max(width, height)) + 1;
			this.levels = [];
			for (var i = 0; i < levelsLength; i++) {
				var level = {
					width: width,
					height: height,
					items: new Int16Array(width * height)
				};
				this.levels.push(level);
				width = Math.ceil(width / 2);
				height = Math.ceil(height / 2);
			}
		}

		InclusionTree.prototype = {
			reset: function InclusionTree_reset(i, j) {
				var currentLevel = 0;
				while (currentLevel < this.levels.length) {
					var level = this.levels[currentLevel];
					var index = i + j * level.width;
					level.index = index;
					var value = level.items[index];

					if (value === 0xFF)
						break;

					i >>= 1;
					j >>= 1;
					currentLevel++;
				}
				this.currentLevel = currentLevel - 1;
				return true;
			},

			incrementValue: function InclusionTree_incrementValue() {
				var level = this.levels[this.currentLevel];
				level.items[level.index] = 1;
			},

			nextLevel: function InclusionTree_nextLevel() {
				var currentLevel = this.currentLevel;
				var level = this.levels[currentLevel];
				var value = level.items[level.index];
				level.items[level.index] = 0xFF;
				currentLevel--;
				if (currentLevel < 0)
					return false;

				this.currentLevel = currentLevel;
				level = this.levels[currentLevel];
				level.items[level.index] = value;
				return true;
			}
		};

		return InclusionTree;
	})();

	// Section D. Coefficient bit modeling
	var BitModel = (function BitModelClosure() {
		var UNIFORM_CONTEXT = 17;
		var RUNLENGTH_CONTEXT = 18;
		// Table D-1
		// The index is binary presentation: 0dddvvhh, ddd - sum of Di (0..4),
		// vv - sum of Vi (0..2), and hh - sum of Hi (0..2)
		var LLAndLHContextsLabel = new Uint8Array([
			0, 5, 8, 0, 3, 7, 8, 0, 4, 7, 8, 0, 0, 0, 0, 0, 1, 6, 8, 0, 3, 7, 8, 0, 4,
			7, 8, 0, 0, 0, 0, 0, 2, 6, 8, 0, 3, 7, 8, 0, 4, 7, 8, 0, 0, 0, 0, 0, 2, 6,
			8, 0, 3, 7, 8, 0, 4, 7, 8, 0, 0, 0, 0, 0, 2, 6, 8, 0, 3, 7, 8, 0, 4, 7, 8
		]);
		var HLContextLabel = new Uint8Array([
			0, 3, 4, 0, 5, 7, 7, 0, 8, 8, 8, 0, 0, 0, 0, 0, 1, 3, 4, 0, 6, 7, 7, 0, 8,
			8, 8, 0, 0, 0, 0, 0, 2, 3, 4, 0, 6, 7, 7, 0, 8, 8, 8, 0, 0, 0, 0, 0, 2, 3,
			4, 0, 6, 7, 7, 0, 8, 8, 8, 0, 0, 0, 0, 0, 2, 3, 4, 0, 6, 7, 7, 0, 8, 8, 8
		]);
		var HHContextLabel = new Uint8Array([
			0, 1, 2, 0, 1, 2, 2, 0, 2, 2, 2, 0, 0, 0, 0, 0, 3, 4, 5, 0, 4, 5, 5, 0, 5,
			5, 5, 0, 0, 0, 0, 0, 6, 7, 7, 0, 7, 7, 7, 0, 7, 7, 7, 0, 0, 0, 0, 0, 8, 8,
			8, 0, 8, 8, 8, 0, 8, 8, 8, 0, 0, 0, 0, 0, 8, 8, 8, 0, 8, 8, 8, 0, 8, 8, 8
		]);

		function BitModel(width, height, subband, zeroBitPlanes, mb) {
			this.width = width;
			this.height = height;

			this.contextLabelTable = (subband === 'HH' ? HHContextLabel : (subband === 'HL' ? HLContextLabel : LLAndLHContextsLabel));

			var coefficientCount = width * height;

			// coefficients outside the encoding region treated as insignificant
			// add border state cells for significanceState
			this.neighborsSignificance = new Uint8Array(coefficientCount);
			this.coefficentsSign = new Uint8Array(coefficientCount);
			this.coefficentsMagnitude = mb > 14 ? new Uint32Array(coefficientCount) : mb > 6 ? new Uint16Array(coefficientCount) : new Uint8Array(coefficientCount);
			this.processingFlags = new Uint8Array(coefficientCount);

			var bitsDecoded = new Uint8Array(coefficientCount);
			if (zeroBitPlanes !== 0)
				for (var i = 0; i < coefficientCount; i++)
					bitsDecoded[i] = zeroBitPlanes;

			this.bitsDecoded = bitsDecoded;

			this.reset();
		}

		BitModel.prototype = {

			setDecoder: function BitModel_setDecoder(decoder) {
				this.decoder = decoder;
			},

			reset: function BitModel_reset() {
				// We have 17 contexts that are accessed via context labels,
				// plus the uniform and runlength context.
				this.contexts = new Int8Array(19);

				// Contexts are packed into 1 byte:
				// highest 7 bits carry the index, lowest bit carries mps
				this.contexts[0] = (4 << 1) | 0;
				this.contexts[UNIFORM_CONTEXT] = (46 << 1) | 0;
				this.contexts[RUNLENGTH_CONTEXT] = (3 << 1) | 0;
			},

			setNeighborsSignificance: function BitModel_setNeighborsSignificance(row, column, index) {
				var neighborsSignificance = this.neighborsSignificance;
				var width = this.width, height = this.height;
				var left = (column > 0);
				var right = (column + 1 < width);
				var i;

				if (row > 0) {
					i = index - width;
					if (left)
						neighborsSignificance[i - 1] += 0x10;
					if (right)
						neighborsSignificance[i + 1] += 0x10;
					neighborsSignificance[i] += 0x04;
				}

				if (row + 1 < height) {
					i = index + width;
					if (left)
						neighborsSignificance[i - 1] += 0x10;
					if (right)
						neighborsSignificance[i + 1] += 0x10;
					neighborsSignificance[i] += 0x04;
				}

				if (left)
					neighborsSignificance[index - 1] += 0x01;
				if (right)
					neighborsSignificance[index + 1] += 0x01;
				neighborsSignificance[index] |= 0x80;
			},

			runSignificancePropogationPass: function BitModel_runSignificancePropogationPass() {

				var decoder = this.decoder;
				var width = this.width, height = this.height;
				var coefficentsMagnitude = this.coefficentsMagnitude;
				var coefficentsSign = this.coefficentsSign;
				var neighborsSignificance = this.neighborsSignificance;
				var processingFlags = this.processingFlags;
				var contexts = this.contexts;
				var labels = this.contextLabelTable;
				var bitsDecoded = this.bitsDecoded;
				var processedInverseMask = ~1;
				var processedMask = 1;
				var firstMagnitudeBitMask = 2;

				for (var i0 = 0; i0 < height; i0 += 4) {
					for (var j = 0; j < width; j++) {
						var index = i0 * width + j;
						for (var i1 = 0; i1 < 4; i1++ , index += width) {
							var i = i0 + i1;
							if (i >= height)
								break;
							
							// clear processed flag first
							processingFlags[index] &= processedInverseMask;

							if (coefficentsMagnitude[index] || !neighborsSignificance[index])
								continue;

							var contextLabel = labels[neighborsSignificance[index]];
							var decision = decoder.readBit(contexts, contextLabel);
							if (decision) {
								var sign = this.decodeSignBit(i, j, index);
								coefficentsSign[index] = sign;
								coefficentsMagnitude[index] = 1;
								this.setNeighborsSignificance(i, j, index);
								processingFlags[index] |= firstMagnitudeBitMask;
							}
							bitsDecoded[index]++;
							processingFlags[index] |= processedMask;
						}
					}
				}
			},

			decodeSignBit: function BitModel_decodeSignBit(row, column, index) {
				var width = this.width, height = this.height;
				var coefficentsMagnitude = this.coefficentsMagnitude;
				var coefficentsSign = this.coefficentsSign;
				var contribution, sign0, sign1, significance1;
				var contextLabel, decoded;

				// calculate horizontal contribution
				significance1 = (column > 0 && coefficentsMagnitude[index - 1] !== 0);
				if (column + 1 < width && coefficentsMagnitude[index + 1] !== 0) {
					sign1 = coefficentsSign[index + 1];
					if (significance1) {
						sign0 = coefficentsSign[index - 1];
						contribution = 1 - sign1 - sign0;
					} else
						contribution = 1 - sign1 - sign1;

				} else if (significance1) {
					sign0 = coefficentsSign[index - 1];
					contribution = 1 - sign0 - sign0;
				} else
					contribution = 0;

				var horizontalContribution = 3 * contribution;

				// calculate vertical contribution and combine with the horizontal
				significance1 = (row > 0 && coefficentsMagnitude[index - width] !== 0);
				if (row + 1 < height && coefficentsMagnitude[index + width] !== 0) {
					sign1 = coefficentsSign[index + width];
					if (significance1) {
						sign0 = coefficentsSign[index - width];
						contribution = 1 - sign1 - sign0 + horizontalContribution;
					} else
						contribution = 1 - sign1 - sign1 + horizontalContribution;

				} else if (significance1) {
					sign0 = coefficentsSign[index - width];
					contribution = 1 - sign0 - sign0 + horizontalContribution;
				} else
					contribution = horizontalContribution;

				if (contribution >= 0) {
					contextLabel = 9 + contribution;
					decoded = this.decoder.readBit(this.contexts, contextLabel);
				} else {
					contextLabel = 9 - contribution;
					decoded = this.decoder.readBit(this.contexts, contextLabel) ^ 1;
				}
				return decoded;
			},

			runMagnitudeRefinementPass: function BitModel_runMagnitudeRefinementPass() {
				var decoder = this.decoder;
				var width = this.width, height = this.height;
				var coefficentsMagnitude = this.coefficentsMagnitude;
				var neighborsSignificance = this.neighborsSignificance;
				var contexts = this.contexts;
				var bitsDecoded = this.bitsDecoded;
				var processingFlags = this.processingFlags;
				var processedMask = 1;
				var firstMagnitudeBitMask = 2;
				var length = width * height;
				var width4 = width * 4;

				for (var index0 = 0, indexNext; index0 < length; index0 = indexNext) {
					indexNext = Math.min(length, index0 + width4);
					for (var j = 0; j < width; j++) {
						for (var index = index0 + j; index < indexNext; index += width) {

							// significant but not those that have just become
							if (!coefficentsMagnitude[index] ||
								(processingFlags[index] & processedMask) !== 0) {
								continue;
							}

							var contextLabel = 16;
							if ((processingFlags[index] & firstMagnitudeBitMask) !== 0) {
								processingFlags[index] ^= firstMagnitudeBitMask;
								// first refinement
								var significance = neighborsSignificance[index] & 127;
								contextLabel = significance === 0 ? 15 : 14;
							}

							var bit = decoder.readBit(contexts, contextLabel);
							coefficentsMagnitude[index] =
							(coefficentsMagnitude[index] << 1) | bit;
							bitsDecoded[index]++;
							processingFlags[index] |= processedMask;
						}
					}
				}
			},

			runCleanupPass: function BitModel_runCleanupPass() {
				var decoder = this.decoder;
				var width = this.width, height = this.height;
				var neighborsSignificance = this.neighborsSignificance;
				var coefficentsMagnitude = this.coefficentsMagnitude;
				var coefficentsSign = this.coefficentsSign;
				var contexts = this.contexts;
				var labels = this.contextLabelTable;
				var bitsDecoded = this.bitsDecoded;
				var processingFlags = this.processingFlags;
				var processedMask = 1;
				var firstMagnitudeBitMask = 2;
				var oneRowDown = width;
				var twoRowsDown = width * 2;
				var threeRowsDown = width * 3;
				var iNext;
				for (var i0 = 0; i0 < height; i0 = iNext) {
					iNext = Math.min(i0 + 4, height);
					var indexBase = i0 * width;
					var checkAllEmpty = i0 + 3 < height;
					for (var j = 0; j < width; j++) {
						var index0 = indexBase + j;
						// using the property: labels[neighborsSignificance[index]] === 0
						// when neighborsSignificance[index] === 0
						var allEmpty = (checkAllEmpty &&
							processingFlags[index0] === 0 &&
							processingFlags[index0 + oneRowDown] === 0 &&
							processingFlags[index0 + twoRowsDown] === 0 &&
							processingFlags[index0 + threeRowsDown] === 0 &&
							neighborsSignificance[index0] === 0 &&
							neighborsSignificance[index0 + oneRowDown] === 0 &&
							neighborsSignificance[index0 + twoRowsDown] === 0 &&
							neighborsSignificance[index0 + threeRowsDown] === 0);
						var i1 = 0, index = index0;
						var i = i0, sign;
						if (allEmpty) {
							var hasSignificantCoefficent =
								decoder.readBit(contexts, RUNLENGTH_CONTEXT);
							if (!hasSignificantCoefficent) {
								bitsDecoded[index0]++;
								bitsDecoded[index0 + oneRowDown]++;
								bitsDecoded[index0 + twoRowsDown]++;
								bitsDecoded[index0 + threeRowsDown]++;
								continue; // next column
							}
							i1 = (decoder.readBit(contexts, UNIFORM_CONTEXT) << 1) |
							decoder.readBit(contexts, UNIFORM_CONTEXT);
							if (i1 !== 0) {
								i = i0 + i1;
								index += i1 * width;
							}

							sign = this.decodeSignBit(i, j, index);
							coefficentsSign[index] = sign;
							coefficentsMagnitude[index] = 1;
							this.setNeighborsSignificance(i, j, index);
							processingFlags[index] |= firstMagnitudeBitMask;

							index = index0;
							for (var i2 = i0; i2 <= i; i2++ , index += width) {
								bitsDecoded[index]++;
							}

							i1++;
						}
						for (i = i0 + i1; i < iNext; i++ , index += width) {
							if (coefficentsMagnitude[index] ||
								(processingFlags[index] & processedMask) !== 0) {
								continue;
							}

							var contextLabel = labels[neighborsSignificance[index]];
							var decision = decoder.readBit(contexts, contextLabel);
							if (decision === 1) {
								sign = this.decodeSignBit(i, j, index);
								coefficentsSign[index] = sign;
								coefficentsMagnitude[index] = 1;
								this.setNeighborsSignificance(i, j, index);
								processingFlags[index] |= firstMagnitudeBitMask;
							}
							bitsDecoded[index]++;
						}
					}
				}
			}
		};

		return BitModel;
	})();

	// Section F, Discrete wavelet transformation
	var Transform = (function TransformClosure() {
		function Transform() { }

		Transform.prototype.calculate = function transformCalculate(subbands, u0, v0) {
			var ll = subbands[0];
			for (var i = 1, ii = subbands.length; i < ii; i++) {
				ll = this.iterate(ll, subbands[i], u0, v0);
			}
			return ll;
		};

		Transform.prototype.extend = function extend(buffer, offset, size) {
			// Section F.3.7 extending... using max extension of 4
			var i1 = offset - 1, j1 = offset + 1;
			var i2 = offset + size - 2, j2 = offset + size;
			buffer[i1--] = buffer[j1++];
			buffer[j2++] = buffer[i2--];
			buffer[i1--] = buffer[j1++];
			buffer[j2++] = buffer[i2--];
			buffer[i1--] = buffer[j1++];
			buffer[j2++] = buffer[i2--];
			buffer[i1] = buffer[j1];
			buffer[j2] = buffer[i2];
		};

		Transform.prototype.iterate = function Transform_iterate(ll, hl_lh_hh,
			u0, v0) {
			var llWidth = ll.width, llHeight = ll.height, llItems = ll.items;
			var width = hl_lh_hh.width;
			var height = hl_lh_hh.height;
			var items = hl_lh_hh.items;
			var i, j, k, l, u, v;

			// Interleave LL according to Section F.3.3
			for (k = 0, i = 0; i < llHeight; i++) {
				l = i * 2 * width;
				for (j = 0; j < llWidth; j++ , k++ , l += 2) {
					items[l] = llItems[k];
				}
			}
			// The LL band is not needed anymore.
			llItems = ll.items = null;

			var bufferPadding = 4;
			var rowBuffer = new Float32Array(width + 2 * bufferPadding);

			// Section F.3.4 HOR_SR
			if (width === 1) {
				// if width = 1, when u0 even keep items as is, when odd divide by 2
				if ((u0 & 1) !== 0) {
					for (v = 0, k = 0; v < height; v++ , k += width) {
						items[k] *= 0.5;
					}
				}
			} else {
				for (v = 0, k = 0; v < height; v++ , k += width) {
					rowBuffer.set(items.subarray(k, k + width), bufferPadding);

					this.extend(rowBuffer, bufferPadding, width);
					this.filter(rowBuffer, bufferPadding, width);

					items.set(
						rowBuffer.subarray(bufferPadding, bufferPadding + width),
						k);
				}
			}

			// Accesses to the items array can take long, because it may not fit into
			// CPU cache and has to be fetched from main memory. Since subsequent
			// accesses to the items array are not local when reading columns, we
			// have a cache miss every time. To reduce cache misses, get up to
			// 'numBuffers' items at a time and store them into the individual
			// buffers. The colBuffers should be small enough to fit into CPU cache.
			var numBuffers = 16;
			var colBuffers = [];
			for (i = 0; i < numBuffers; i++) {
				colBuffers.push(new Float32Array(height + 2 * bufferPadding));
			}
			var b, currentBuffer = 0;
			ll = bufferPadding + height;

			// Section F.3.5 VER_SR
			if (height === 1) {
				// if height = 1, when v0 even keep items as is, when odd divide by 2
				if ((v0 & 1) !== 0) {
					for (u = 0; u < width; u++) {
						items[u] *= 0.5;
					}
				}
			} else {
				for (u = 0; u < width; u++) {
					// if we ran out of buffers, copy several image columns at once
					if (currentBuffer === 0) {
						numBuffers = Math.min(width - u, numBuffers);
						for (k = u, l = bufferPadding; l < ll; k += width, l++) {
							for (b = 0; b < numBuffers; b++) {
								colBuffers[b][l] = items[k + b];
							}
						}
						currentBuffer = numBuffers;
					}

					currentBuffer--;
					var buffer = colBuffers[currentBuffer];
					this.extend(buffer, bufferPadding, height);
					this.filter(buffer, bufferPadding, height);

					// If this is last buffer in this group of buffers, flush all buffers.
					if (currentBuffer === 0) {
						k = u - numBuffers + 1;
						for (l = bufferPadding; l < ll; k += width, l++) {
							for (b = 0; b < numBuffers; b++) {
								items[k + b] = colBuffers[b][l];
							}
						}
					}
				}
			}

			return {
				width: width,
				height: height,
				items: items
			};
		};

		return Transform;
	})();

	// Section 3.8.1 Reversible 5-3 filter
	var ReversibleTransform = (function ReversibleTransformClosure() {
		function ReversibleTransform() {
			Transform.call(this);
		}

		ReversibleTransform.prototype = Object.create(Transform.prototype);
		ReversibleTransform.prototype.filter =
		function reversibleTransformFilter(x, offset, length) {
			var len = length >> 1;
			offset = offset | 0;
			var j, n;

			for (j = offset, n = len + 1; n--; j += 2) {
				x[j] -= (x[j - 1] + x[j + 1] + 2) >> 2;
			}

			for (j = offset + 1, n = len; n--; j += 2) {
				x[j] += (x[j - 1] + x[j + 1]) >> 1;
			}
		};

		return ReversibleTransform;
	})();

	return JpxImage;
})();

/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

/* This class implements the QM Coder decoding as defined in
 *   JPEG 2000 Part I Final Committee Draft Version 1.0
 *   Annex C.3 Arithmetic decoding procedure 
 * available at http://www.jpeg.org/public/fcd15444-1.pdf
 * 
 * The arithmetic decoder is used in conjunction with context models to decode
 * JPEG2000 and JBIG2 streams.
 */
var ArithmeticDecoder = (function ArithmeticDecoderClosure() {
	// Table C-2
	var QeTable = [
		{ qe: 0x5601, nmps: 1, nlps: 1, switchFlag: 1 },
		{ qe: 0x3401, nmps: 2, nlps: 6, switchFlag: 0 },
		{ qe: 0x1801, nmps: 3, nlps: 9, switchFlag: 0 },
		{ qe: 0x0AC1, nmps: 4, nlps: 12, switchFlag: 0 },
		{ qe: 0x0521, nmps: 5, nlps: 29, switchFlag: 0 },
		{ qe: 0x0221, nmps: 38, nlps: 33, switchFlag: 0 },
		{ qe: 0x5601, nmps: 7, nlps: 6, switchFlag: 1 },
		{ qe: 0x5401, nmps: 8, nlps: 14, switchFlag: 0 },
		{ qe: 0x4801, nmps: 9, nlps: 14, switchFlag: 0 },
		{ qe: 0x3801, nmps: 10, nlps: 14, switchFlag: 0 },
		{ qe: 0x3001, nmps: 11, nlps: 17, switchFlag: 0 },
		{ qe: 0x2401, nmps: 12, nlps: 18, switchFlag: 0 },
		{ qe: 0x1C01, nmps: 13, nlps: 20, switchFlag: 0 },
		{ qe: 0x1601, nmps: 29, nlps: 21, switchFlag: 0 },
		{ qe: 0x5601, nmps: 15, nlps: 14, switchFlag: 1 },
		{ qe: 0x5401, nmps: 16, nlps: 14, switchFlag: 0 },
		{ qe: 0x5101, nmps: 17, nlps: 15, switchFlag: 0 },
		{ qe: 0x4801, nmps: 18, nlps: 16, switchFlag: 0 },
		{ qe: 0x3801, nmps: 19, nlps: 17, switchFlag: 0 },
		{ qe: 0x3401, nmps: 20, nlps: 18, switchFlag: 0 },
		{ qe: 0x3001, nmps: 21, nlps: 19, switchFlag: 0 },
		{ qe: 0x2801, nmps: 22, nlps: 19, switchFlag: 0 },
		{ qe: 0x2401, nmps: 23, nlps: 20, switchFlag: 0 },
		{ qe: 0x2201, nmps: 24, nlps: 21, switchFlag: 0 },
		{ qe: 0x1C01, nmps: 25, nlps: 22, switchFlag: 0 },
		{ qe: 0x1801, nmps: 26, nlps: 23, switchFlag: 0 },
		{ qe: 0x1601, nmps: 27, nlps: 24, switchFlag: 0 },
		{ qe: 0x1401, nmps: 28, nlps: 25, switchFlag: 0 },
		{ qe: 0x1201, nmps: 29, nlps: 26, switchFlag: 0 },
		{ qe: 0x1101, nmps: 30, nlps: 27, switchFlag: 0 },
		{ qe: 0x0AC1, nmps: 31, nlps: 28, switchFlag: 0 },
		{ qe: 0x09C1, nmps: 32, nlps: 29, switchFlag: 0 },
		{ qe: 0x08A1, nmps: 33, nlps: 30, switchFlag: 0 },
		{ qe: 0x0521, nmps: 34, nlps: 31, switchFlag: 0 },
		{ qe: 0x0441, nmps: 35, nlps: 32, switchFlag: 0 },
		{ qe: 0x02A1, nmps: 36, nlps: 33, switchFlag: 0 },
		{ qe: 0x0221, nmps: 37, nlps: 34, switchFlag: 0 },
		{ qe: 0x0141, nmps: 38, nlps: 35, switchFlag: 0 },
		{ qe: 0x0111, nmps: 39, nlps: 36, switchFlag: 0 },
		{ qe: 0x0085, nmps: 40, nlps: 37, switchFlag: 0 },
		{ qe: 0x0049, nmps: 41, nlps: 38, switchFlag: 0 },
		{ qe: 0x0025, nmps: 42, nlps: 39, switchFlag: 0 },
		{ qe: 0x0015, nmps: 43, nlps: 40, switchFlag: 0 },
		{ qe: 0x0009, nmps: 44, nlps: 41, switchFlag: 0 },
		{ qe: 0x0005, nmps: 45, nlps: 42, switchFlag: 0 },
		{ qe: 0x0001, nmps: 45, nlps: 43, switchFlag: 0 },
		{ qe: 0x5601, nmps: 46, nlps: 46, switchFlag: 0 }
	];

	// C.3.5 Initialisation of the decoder (INITDEC)
	function ArithmeticDecoder(data, start, end) {
		this.data = data;
		this.bp = start;
		this.dataEnd = end;

		this.chigh = data[start];
		this.clow = 0;

		this.byteIn();

		this.chigh = ((this.chigh << 7) & 0xFFFF) | ((this.clow >> 9) & 0x7F);
		this.clow = (this.clow << 7) & 0xFFFF;
		this.ct -= 7;
		this.a = 0x8000;
	}

	ArithmeticDecoder.prototype = {
		// C.3.4 Compressed data input (BYTEIN)
		byteIn: function ArithmeticDecoder_byteIn() {
			var data = this.data;
			var bp = this.bp;
			if (data[bp] === 0xFF) {
				var b1 = data[bp + 1];
				if (b1 > 0x8F) {
					this.clow += 0xFF00;
					this.ct = 8;
				} else {
					bp++;
					this.clow += (data[bp] << 9);
					this.ct = 7;
					this.bp = bp;
				}
			} else {
				bp++;
				this.clow += bp < this.dataEnd ? (data[bp] << 8) : 0xFF00;
				this.ct = 8;
				this.bp = bp;
			}
			if (this.clow > 0xFFFF) {
				this.chigh += (this.clow >> 16);
				this.clow &= 0xFFFF;
			}
		},
		// C.3.2 Decoding a decision (DECODE)
		readBit: function ArithmeticDecoder_readBit(contexts, pos) {
			// contexts are packed into 1 byte:
			// highest 7 bits carry cx.index, lowest bit carries cx.mps
			var cx_index = contexts[pos] >> 1, cx_mps = contexts[pos] & 1;
			var qeTableIcx = QeTable[cx_index];
			var qeIcx = qeTableIcx.qe;
			var d;
			var a = this.a - qeIcx;

			if (this.chigh < qeIcx) {
				// exchangeLps
				if (a < qeIcx) {
					a = qeIcx;
					d = cx_mps;
					cx_index = qeTableIcx.nmps;
				} else {
					a = qeIcx;
					d = 1 ^ cx_mps;
					if (qeTableIcx.switchFlag === 1) 
						cx_mps = d;
					cx_index = qeTableIcx.nlps;
				}
			} else {
				this.chigh -= qeIcx;
				if ((a & 0x8000) !== 0) {
					this.a = a;
					return cx_mps;
				}
				// exchangeMps
				if (a < qeIcx) {
					d = 1 ^ cx_mps;
					if (qeTableIcx.switchFlag === 1) 
						cx_mps = d;
					cx_index = qeTableIcx.nlps;
				} else {
					d = cx_mps;
					cx_index = qeTableIcx.nmps;
				}
			}
			// C.3.3 renormD;
			do {
				if (this.ct === 0) {
					this.byteIn();
				}

				a <<= 1;
				this.chigh = ((this.chigh << 1) & 0xFFFF) | ((this.clow >> 15) & 1);
				this.clow = (this.clow << 1) & 0xFFFF;
				this.ct--;
			} while ((a & 0x8000) === 0);
			this.a = a;

			contexts[pos] = cx_index << 1 | cx_mps;
			return d;
		}
	};

	return ArithmeticDecoder;
})();


function log2(x) {
	var n = 1, i = 0;
	while (x > n) {
		n <<= 1;
		i++;
	}
	return i;
}

function readUint16(data, offset) {
	return (data[offset] << 8) | data[offset + 1];
}

function readUint32(data, offset) {
	return ((data[offset] << 24) | (data[offset + 1] << 16) |
		(data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}
