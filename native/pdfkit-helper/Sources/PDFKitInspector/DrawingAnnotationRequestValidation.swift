import Foundation
import CoreGraphics

func strictLineAnnotationRequest(from data: Data) throws -> LineAnnotationRequest {
    guard data.count <= maxRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(object, ["version", "operation", "inputFilename", "outputFilename", "sourceSha256", "limits", "line"]),
          let limits = object["limits"] as? [String: Any],
          exactKeys(limits, ["maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage", "maxOutlineDepth", "maxOutlineItems"]),
          let line = object["line"] as? [String: Any],
          exactKeys(line, ["page", "contents", "start", "end"]),
          let start = line["start"] as? [String: Any], exactMeasurementPoint(start),
          let end = line["end"] as? [String: Any], exactMeasurementPoint(end)
    else { throw InspectionFailure.invalidRequest }

    let decoder = JSONDecoder()
    let request: LineAnnotationRequest
    do { request = try decoder.decode(LineAnnotationRequest.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }

    guard request.version == protocolVersion,
          request.operation == "addLineAnnotation",
          request.inputFilename == mutationInputFilename,
          request.outputFilename == mutationOutputFilename,
          isLowercaseSHA256(request.sourceSha256),
          isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 1, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 0, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 0, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 0, maximumOutlineItems),
          validMutationPage(request.line.page),
          isWithin(request.line.contents.utf8.count, 1, maximumStringLength),
          validLineAnnotationPoint(request.line.start),
          validLineAnnotationPoint(request.line.end),
          request.line.start.x != request.line.end.x || request.line.start.y != request.line.end.y
    else { throw InspectionFailure.invalidRequest }
    return request
}

func strictInkAnnotationRequest(from data: Data) throws -> InkAnnotationRequest {
    guard data.count <= maxRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(object, ["version", "operation", "inputFilename", "outputFilename", "sourceSha256", "limits", "ink"]),
          let limits = object["limits"] as? [String: Any],
          exactKeys(limits, ["maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage", "maxOutlineDepth", "maxOutlineItems"]),
          let ink = object["ink"] as? [String: Any],
          exactKeys(ink, ["page", "contents", "points"]),
          let points = ink["points"] as? [[String: Any]],
          isWithin(points.count, 2, 32), points.allSatisfy(exactMeasurementPoint)
    else { throw InspectionFailure.invalidRequest }

    let decoder = JSONDecoder()
    let request: InkAnnotationRequest
    do { request = try decoder.decode(InkAnnotationRequest.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }

    let coordinates = request.ink.points.map(inkAnnotationPoint)
    guard request.version == protocolVersion,
          request.operation == "addInkAnnotation",
          request.inputFilename == mutationInputFilename,
          request.outputFilename == mutationOutputFilename,
          isLowercaseSHA256(request.sourceSha256),
          isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 1, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 0, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 0, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 0, maximumOutlineItems),
          validMutationPage(request.ink.page),
          isWithin(request.ink.contents.utf8.count, 1, maximumStringLength),
          coordinates.allSatisfy(validInkAnnotationPoint),
          zip(coordinates, coordinates.dropFirst()).allSatisfy({ pair in
              pair.0.x != pair.1.x || pair.0.y != pair.1.y
          })
    else { throw InspectionFailure.invalidRequest }
    return request
}

func validLineAnnotationPoint(_ point: LineAnnotationPoint) -> Bool {
    [point.x, point.y].allSatisfy { $0.isFinite && abs($0) <= maximumCoordinate }
}

func inkAnnotationPoint(_ point: InkAnnotationPoint) -> CGPoint {
    CGPoint(x: point.x, y: point.y)
}

func validInkAnnotationPoint(_ point: CGPoint) -> Bool {
    [Double(point.x), Double(point.y)].allSatisfy { $0.isFinite && abs($0) <= maximumCoordinate }
}
