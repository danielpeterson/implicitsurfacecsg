# Naive implicit surface CSG solver

This code is a naive CSG solver for implicit surfaces. It visualizes surfaces and edges using random point clouds.

The idea is to handle surfaces as implicit volumes. Surfaces are defined as an implicit distance field and are unbounded. For every point in space the surface can give a closest point on the surface and a surface normal at that point.

A set of surfaces are organized into a CSG tree. The final model is visualized as a set of random point that lie on the surfaces that make up the CSG model. Points that are not part of the surface of the final CSG object are removed by evaluating them against the CSG tree.

Edges are visualized by creating points at the intersection of all surface pairs. These poins are then culled the same way as for surface points.

One limitaiton of this model representation is that surfaces have to be reasonably convex. To mitigate this one would have to add some form of spatial subdivition of the surfaces to allow the CSG evaluation to search for intersections etc. along non-convex sections of surfaces.

Currently only plane, cylinder and sphere surfaces are implemented. Theoretically other surface types could be implemented. Most interesting would be to implement chamfers and fillets as implicit surfaces that depend on the interseciton of other surfaces.

Much work remains for this to be useful. It is intended as a playground for anyone that wants to experiment with ideas around CSG modeling.

It is interesting to note that user interaction can be created by generating approximate edges that serves as visual representations of the underlying implicit edges. The user then has a way to indicate that they want to for example add a chamfer or fillet by interacting with the visual edge.


You can test it online here:
https://danielpeterson.github.io/implicitsurfacecsg

## License

Modified MIT license without any need for attribution.
