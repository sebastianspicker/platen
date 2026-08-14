import Foundation
import PDFKit
import AppKit
import Darwin
import CryptoKit
import CoreGraphics

func lineAnnotationGraphIsSafe(_ document: PDFDocument, limits: Limits) -> Bool {
    rawLocalGoToGraphIsSafe(document, limits: limits, allowing: nil)
}

func lineAnnotationPoint(_ point: LineAnnotationPoint) -> CGPoint {
    CGPoint(x: point.x, y: point.y)
}

func cropBoxContains(_ point: CGPoint, crop: CGRect) -> Bool {
    !crop.isNull && !crop.isInfinite && crop.width > 0 && crop.height > 0
        && point.x >= crop.minX && point.x <= crop.maxX
        && point.y >= crop.minY && point.y <= crop.maxY
}

func lineAnnotationSnapshot(
    _ request: LineAnnotationRequest,
    document: PDFDocument
) -> LineAnnotationSnapshot? {
    let start = lineAnnotationPoint(request.line.start)
    let end = lineAnnotationPoint(request.line.end)
    guard !document.isLocked, document.allowsCommenting, document.allowsDocumentChanges,
          document.pageCount >= 1, document.pageCount <= request.limits.maxPages,
          request.line.page <= document.pageCount,
          let targetPage = document.page(at: request.line.page - 1),
          targetPage.annotations.count < request.limits.maxAnnotationsPerPage,
          targetPage.annotations.count < maximumAnnotationsPerPage,
          cropBoxContains(start, crop: targetPage.bounds(for: .cropBox)),
          cropBoxContains(end, crop: targetPage.bounds(for: .cropBox)),
          boundedGeometryRect([start, end], crop: targetPage.bounds(for: .cropBox)) != nil,
          lineAnnotationGraphIsSafe(document, limits: request.limits)
    else { return nil }

    var pageBoxes: [PageBoxes] = []
    var rotations: [Int] = []
    var annotationCounts: [Int] = []
    var annotationSubtypes: [[String]] = []
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              page.annotations.count <= request.limits.maxAnnotationsPerPage,
              page.annotations.count <= maximumAnnotationsPerPage
        else { return nil }
        pageBoxes.append(localGoToPageBoxes(page))
        rotations.append(page.rotation)
        annotationCounts.append(page.annotations.count)
        annotationSubtypes.append(page.annotations.map(annotationSubtype))
    }
    return LineAnnotationSnapshot(
        pageCount: document.pageCount,
        pageBoxes: pageBoxes,
        pageRotations: rotations,
        annotationCounts: annotationCounts,
        annotationSubtypes: annotationSubtypes
    )
}

func applyLineAnnotation(_ line: LineAnnotationEdit, document: PDFDocument) -> Bool {
    guard let page = document.page(at: line.page - 1) else { return false }
    let start = lineAnnotationPoint(line.start)
    let end = lineAnnotationPoint(line.end)
    guard let bounds = boundedGeometryRect([start, end], crop: page.bounds(for: .cropBox)) else {
        return false
    }
    let annotation = PDFAnnotation(bounds: bounds, forType: .line, withProperties: nil)
    annotation.startPoint = annotationSpacePoint(start, bounds: bounds)
    annotation.endPoint = annotationSpacePoint(end, bounds: bounds)
    annotation.startLineStyle = .none
    annotation.endLineStyle = .none
    annotation.contents = line.contents
    page.addAnnotation(annotation)
    return page.annotations.last === annotation
}

func verifiesLineAnnotation(
    _ request: LineAnnotationRequest,
    document: PDFDocument,
    snapshot: LineAnnotationSnapshot
) -> Int? {
    guard document.pageCount == snapshot.pageCount,
          snapshot.pageBoxes.count == document.pageCount,
          snapshot.pageRotations.count == document.pageCount,
          snapshot.annotationCounts.count == document.pageCount,
          snapshot.annotationSubtypes.count == document.pageCount,
          lineAnnotationGraphIsSafe(document, limits: request.limits)
    else { return nil }

    let targetPageIndex = request.line.page - 1
    let newAnnotationIndex = snapshot.annotationCounts[targetPageIndex]
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              localGoToPageBoxes(page) == snapshot.pageBoxes[pageIndex],
              page.rotation == snapshot.pageRotations[pageIndex]
        else { return nil }
        let addedHere = pageIndex == targetPageIndex ? 1 : 0
        guard page.annotations.count == snapshot.annotationCounts[pageIndex] + addedHere,
              page.annotations.map(annotationSubtype)
                == snapshot.annotationSubtypes[pageIndex] + (addedHere == 1 ? ["line"] : [])
        else { return nil }
    }

    guard let page = document.page(at: targetPageIndex),
          newAnnotationIndex < page.annotations.count
    else { return nil }
    let annotation = page.annotations[newAnnotationIndex]
    let crop = page.bounds(for: .cropBox)
    let bounds = annotation.bounds
    let expectedStart = lineAnnotationPoint(request.line.start)
    let expectedEnd = lineAnnotationPoint(request.line.end)
    let observedStart = CGPoint(
        x: bounds.minX + annotation.startPoint.x,
        y: bounds.minY + annotation.startPoint.y
    )
    let observedEnd = CGPoint(
        x: bounds.minX + annotation.endPoint.x,
        y: bounds.minY + annotation.endPoint.y
    )
    guard annotationSubtype(annotation) == "line",
          annotation.contents == request.line.contents,
          !bounds.isNull, !bounds.isInfinite, bounds.width > 0, bounds.height > 0,
          crop.contains(bounds),
          closeEnough(observedStart, expectedStart), closeEnough(observedEnd, expectedEnd),
          annotation.startLineStyle == .none, annotation.endLineStyle == .none,
          annotationIsInertTarget(annotation),
          rawLineAnnotationMatches(
              document,
              page: request.line.page,
              annotationIndex: newAnnotationIndex,
              start: expectedStart,
              end: expectedEnd
          )
    else { return nil }
    return newAnnotationIndex
}

func addLineAnnotation(
    _ request: LineAnnotationRequest,
    workspace: URL,
    inputData: Data
) throws -> LineAnnotationReceipt {
    let sourceDigest = sha256Hex(inputData)
    guard sourceDigest == request.sourceSha256,
          let document = PDFDocument(data: inputData),
          let snapshot = lineAnnotationSnapshot(request, document: document),
          applyLineAnnotation(request.line, document: document),
          let outputData = document.dataRepresentation(), outputData.count <= maxOutputBytes,
          sha256Hex(outputData) != sourceDigest,
          let candidate = PDFDocument(data: outputData),
          verifiesLineAnnotation(request, document: candidate, snapshot: snapshot) != nil
    else { throw InspectionFailure.mutationFailed }

    let output = workspace.appendingPathComponent(request.outputFilename)
    try writePrivateOutput(outputData, to: output)
    let reopenedData = try readPrivateInput(output)
    guard let reopened = PDFDocument(data: reopenedData),
          let annotationIndex = verifiesLineAnnotation(request, document: reopened, snapshot: snapshot)
    else { throw InspectionFailure.outputInvalid }
    let outputDigest = sha256Hex(reopenedData)
    guard outputDigest != sourceDigest else { throw InspectionFailure.outputInvalid }
    return LineAnnotationReceipt(
        sourceSha256: sourceDigest,
        outputSha256: outputDigest,
        page: request.line.page,
        annotationIndex: annotationIndex,
        pageCount: reopened.pageCount
    )
}

